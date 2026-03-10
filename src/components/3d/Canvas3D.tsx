import { useStore, Room, Furniture, Wall, Cylinder, Door, Surface, Floor, Stair, Ruler, defaultLayerSettings } from '../../store/useStore';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Environment, ContactShadows, Box, Plane, Cylinder as CylinderShape } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import {
    buildRoomWallSegments,
    getRectIntersection,
    getRoomBounds,
    getRoomCorners,
    getRoomPolygon,
    getStairOpeningFloorId,
    getWallSegment,
    resolveDoorPlacement,
    subtractRectHolesFromRect,
    subtractWallOverlapsFromRoomSegments,
    type FittedDoorPlacement,
    type Rect2D,
    type RoomWallSegment
} from '../../utils/buildingGeometry';
import { getFurniturePreset } from '../../utils/furnitureCatalog';
import { clampSpiralCoreRadius, directionToAngle, getStairKind } from '../../utils/stairUtils';

const DEFAULT_LEVEL_HEIGHT = 3.2;
const WALL_THICKNESS = 0.18;
const FLOOR_THICKNESS = 0.12;
const CEILING_THICKNESS = 0.035;
const FLOOR_SURFACE_LIFT = 0.004;
const CEILING_CLEARANCE = 0.018;
const SURFACE_CLEARANCE = 0.014;
const ROOM_WALL_COLOR = '#eef2f6';
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ignoreLockedRaycast = () => null;
const ROOM_FLOOR_RENDER_ORDER = 8;
const ROOM_CEILING_RENDER_ORDER = 9;
const SURFACE_RENDER_ORDER = 12;
const RULER_RENDER_ORDER = 16;
const LEVEL_SURFACE_OFFSET = 0.028;

function usesTransparentPass(opacity: number) {
    return opacity < 0.999;
}

function getFloorRenderBaseOrder(floor: Floor) {
    return Math.round(floor.elevation * 100) * 24;
}

function getBlendMaterialProps(opacity: number) {
    const transparent = usesTransparentPass(opacity);

    return {
        transparent,
        opacity,
        depthWrite: !transparent,
        depthTest: true,
        premultipliedAlpha: transparent,
        blending: THREE.NormalBlending
    };
}

function isPointInsidePolygon(point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>) {
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;

        const intersects = ((yi > point.y) !== (yj > point.y))
            && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 0.0000001) + xi);

        if (intersects) {
            inside = !inside;
        }
    }

    return inside;
}

function isPolygonInsidePolygon(inner: Array<{ x: number; y: number }>, outer: Array<{ x: number; y: number }>) {
    return inner.every((point) => isPointInsidePolygon(point, outer));
}

function createShapePath(points: Array<{ x: number; y: number }>, reverse = false) {
    const ordered = reverse ? [...points].reverse() : points;
    const path = new THREE.Path();

    ordered.forEach((point, index) => {
        if (index === 0) {
            path.moveTo(point.x, point.y);
            return;
        }
        path.lineTo(point.x, point.y);
    });

    path.closePath();
    return path;
}

type WallOpening = {
    startDistance: number;
    endDistance: number;
    doorHeight: number;
};

function projectDistanceOnSegment(
    segmentStart: { x: number; y: number },
    segmentEnd: { x: number; y: number },
    point: { x: number; y: number }
) {
    const dx = segmentEnd.x - segmentStart.x;
    const dy = segmentEnd.y - segmentStart.y;
    const length = Math.hypot(dx, dy);
    if (length <= 0.0001) return 0;

    return ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) / length;
}

function normalizeWallOpenings(openings: WallOpening[], length: number, height: number) {
    const prepared = openings
        .map((opening) => {
            const startDistance = THREE.MathUtils.clamp(opening.startDistance, 0, length);
            const endDistance = THREE.MathUtils.clamp(opening.endDistance, 0, length);
            return {
                startDistance: Math.min(startDistance, endDistance),
                endDistance: Math.max(startDistance, endDistance),
                doorHeight: THREE.MathUtils.clamp(opening.doorHeight, 0.5, height - 0.05)
            };
        })
        .filter((opening) => opening.endDistance - opening.startDistance > 0.04)
        .sort((a, b) => a.startDistance - b.startDistance);

    return prepared.reduce<WallOpening[]>((memo, opening) => {
        const last = memo[memo.length - 1];
        if (!last || opening.startDistance > last.endDistance + 0.02) {
            memo.push(opening);
            return memo;
        }

        last.endDistance = Math.max(last.endDistance, opening.endDistance);
        last.doorHeight = Math.max(last.doorHeight, opening.doorHeight);
        return memo;
    }, []);
}

function WallWithOpenings({
    start,
    angle,
    baseElevation,
    length,
    height,
    thickness,
    color,
    openings = [],
    opacity = 1,
    renderOrder = 0
}: {
    start: { x: number; y: number };
    angle: number;
    baseElevation: number;
    length: number;
    height: number;
    thickness: number;
    color: string;
    openings?: WallOpening[];
    opacity?: number;
    renderOrder?: number;
}) {
    const normalizedOpenings = useMemo(
        () => normalizeWallOpenings(openings, length, height),
        [height, length, openings]
    );

    const segments = useMemo(() => {
        const meshes: Array<{ key: string; args: [number, number, number]; position: [number, number, number] }> = [];
        let cursor = 0;

        normalizedOpenings.forEach((opening, index) => {
            const leftSpan = opening.startDistance - cursor;
            if (leftSpan > 0.02) {
                meshes.push({
                    key: `solid-${index}-${cursor.toFixed(3)}`,
                    args: [leftSpan, height, thickness],
                    position: [cursor + leftSpan / 2, height / 2, 0]
                });
            }

            const headerHeight = height - opening.doorHeight;
            if (headerHeight > 0.02) {
                const headerWidth = opening.endDistance - opening.startDistance;
                meshes.push({
                    key: `header-${index}-${opening.startDistance.toFixed(3)}`,
                    args: [headerWidth, headerHeight, thickness],
                    position: [opening.startDistance + headerWidth / 2, opening.doorHeight + headerHeight / 2, 0]
                });
            }

            cursor = opening.endDistance;
        });

        const tailSpan = length - cursor;
        if (tailSpan > 0.02) {
            meshes.push({
                key: `tail-${cursor.toFixed(3)}`,
                args: [tailSpan, height, thickness],
                position: [cursor + tailSpan / 2, height / 2, 0]
            });
        }

        if (normalizedOpenings.length === 0) {
            return [{
                key: 'full',
                args: [length, height, thickness] as [number, number, number],
                position: [length / 2, height / 2, 0] as [number, number, number]
            }];
        }

        return meshes;
    }, [height, length, normalizedOpenings, thickness]);

    return (
        <group position={[start.x, baseElevation, start.y]} rotation={[0, -angle, 0]}>
            {segments.map((segment) => (
                <Box key={segment.key} args={segment.args} position={segment.position} castShadow receiveShadow renderOrder={renderOrder}>
                    <meshStandardMaterial color={color} {...getBlendMaterialProps(opacity)} />
                </Box>
            ))}
        </group>
    );
}

function fitCameraToBounds(camera: THREE.PerspectiveCamera, controls: OrbitControlsImpl, bounds: THREE.Box3) {
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 6);
    const distance = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.78;
    const direction = new THREE.Vector3(1, 0.72, 1).normalize();
    const nextPosition = center.clone().add(direction.multiplyScalar(distance));

    camera.position.copy(nextPosition);
    camera.near = 0.1;
    camera.far = Math.max(300, distance * 12);
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.minDistance = Math.max(2, radius * 0.15);
    controls.maxDistance = Math.max(80, radius * 8);
    controls.update();
}

function buildSceneBounds(
    visibleFloors: Floor[],
    rooms: Room[],
    walls: Wall[],
    cylinders: Cylinder[],
    furniture: Furniture[],
    surfaces: Surface[],
    stairs: Stair[],
    rulers: Ruler[]
) {
    const floorMap = new Map(visibleFloors.map((floor) => [floor.id, floor]));
    const bounds = new THREE.Box3();
    let hasGeometry = false;

    const expand = (min: THREE.Vector3, max: THREE.Vector3) => {
        if (!hasGeometry) {
            bounds.set(min.clone(), max.clone());
            hasGeometry = true;
            return;
        }
        bounds.expandByPoint(min);
        bounds.expandByPoint(max);
    };

    rooms.forEach((room) => {
        const floor = floorMap.get(room.floorId);
        if (!floor) return;
        const height = room.wallHeight || floor.height || DEFAULT_LEVEL_HEIGHT;
        const corners = getRoomCorners(room);
        const xs = corners.map((corner) => corner.x);
        const zs = corners.map((corner) => corner.y);
        expand(
            new THREE.Vector3(Math.min(...xs), floor.elevation, Math.min(...zs)),
            new THREE.Vector3(Math.max(...xs), floor.elevation + height, Math.max(...zs))
        );
    });

    walls.forEach((wall) => {
        const floor = floorMap.get(wall.floorId);
        if (!floor) return;
        const height = wall.wallHeight || floor.height || DEFAULT_LEVEL_HEIGHT;
        expand(
            new THREE.Vector3(Math.min(wall.startX, wall.endX), floor.elevation, Math.min(wall.startY, wall.endY)),
            new THREE.Vector3(Math.max(wall.startX, wall.endX), floor.elevation + height, Math.max(wall.startY, wall.endY))
        );
    });

    cylinders.forEach((cylinder) => {
        const floor = floorMap.get(cylinder.floorId);
        if (!floor) return;
        const height = cylinder.wallHeight || floor.height || DEFAULT_LEVEL_HEIGHT;
        expand(
            new THREE.Vector3(cylinder.x - cylinder.radius, floor.elevation, cylinder.y - cylinder.radius),
            new THREE.Vector3(cylinder.x + cylinder.radius, floor.elevation + height, cylinder.y + cylinder.radius)
        );
    });

    furniture.forEach((item) => {
        const floor = floorMap.get(item.floorId);
        if (!floor) return;
        const preset = getFurniturePreset(item.type);
        const width = item.width ?? preset.width;
        const height = item.height ?? preset.height;
        const depth = item.depth ?? preset.depth;
        const altitude = item.altitude || 0;

        expand(
            new THREE.Vector3(item.x, floor.elevation + altitude, item.y),
            new THREE.Vector3(item.x + width, floor.elevation + altitude + height, item.y + depth)
        );
    });

    surfaces.forEach((surface) => {
        const floor = floorMap.get(surface.floorId);
        if (!floor || surface.points.length === 0) return;

        const xs = surface.points.map((point) => point.x);
        const ys = surface.points.map((point) => point.y);
        const altitude = surface.altitude || 0;
        const depth = surface.depth || 0.1;

        expand(
            new THREE.Vector3(Math.min(...xs), floor.elevation + altitude, Math.min(...ys)),
            new THREE.Vector3(Math.max(...xs), floor.elevation + altitude + depth, Math.max(...ys))
        );
    });

    stairs.forEach((stair) => {
        const floor = floorMap.get(stair.floorId);
        const targetFloor = floorMap.get(stair.targetFloorId);
        if (!floor || !targetFloor) return;

        expand(
            new THREE.Vector3(stair.x, Math.min(floor.elevation, targetFloor.elevation), stair.y),
            new THREE.Vector3(stair.x + stair.width, Math.max(floor.elevation, targetFloor.elevation) + floor.height, stair.y + stair.height)
        );
    });

    rulers.forEach((ruler) => {
        const floor = floorMap.get(ruler.floorId);
        if (!floor) return;

        expand(
            new THREE.Vector3(Math.min(ruler.startX, ruler.endX), floor.elevation, Math.min(ruler.startY, ruler.endY)),
            new THREE.Vector3(Math.max(ruler.startX, ruler.endX), floor.elevation + 0.12, Math.max(ruler.startY, ruler.endY))
        );
    });

    if (!hasGeometry) {
        bounds.set(new THREE.Vector3(-6, 0, -6), new THREE.Vector3(6, 6, 6));
    }

    bounds.expandByScalar(2);
    return bounds;
}

function Room3D({ room, floor, openings = [] }: { room: Room; floor: Floor; openings?: Rect2D[] }) {
    const { setActiveFloor, setSelectedElement } = useStore();
    const layer = (floor.layerSettings || defaultLayerSettings).rooms;
    if (layer && !layer.visible) return null;
    const opacity = layer?.opacity ?? 1;
    const isTransparent = usesTransparentPass(opacity);
    const showFloor = room.showFloor ?? false;
    const rotationRadians = -THREE.MathUtils.degToRad(room.rotation || 0);
    const roomHeight = room.wallHeight || floor.height || DEFAULT_LEVEL_HEIGHT;
    const floorTopY = floor.elevation + FLOOR_SURFACE_LIFT;
    const ceilingTopY = floor.elevation + Math.max(roomHeight - CEILING_CLEARANCE, FLOOR_THICKNESS + CEILING_THICKNESS);
    const ceilingCenterY = ceilingTopY - CEILING_THICKNESS / 2;
    const floorRenderOrder = getFloorRenderBaseOrder(floor) + ROOM_FLOOR_RENDER_ORDER;
    const ceilingRenderOrder = getFloorRenderBaseOrder(floor) + ROOM_CEILING_RENDER_ORDER;
    const ceilingColor = useMemo(
        () => new THREE.Color(room.color || '#dddddd').lerp(new THREE.Color('#ffffff'), 0.22),
        [room.color]
    );
    const floorPatches = useMemo(
        () => subtractRectHolesFromRect({ x: room.x, y: room.y, width: room.width, height: room.height }, openings),
        [openings, room.height, room.width, room.x, room.y]
    );
    const canUseOpenings = Math.abs(room.rotation || 0) <= 0.01;
    const polygonShape = useMemo(() => {
        if (!room.points || room.points.length < 3) return null;

        const shape = new THREE.Shape();
        room.points.forEach((point, index) => {
            if (index === 0) {
                shape.moveTo(point.x, point.y);
                return;
            }
            shape.lineTo(point.x, point.y);
        });
        shape.closePath();
        return shape;
    }, [room.points]);
    const handleSelect = (event: any) => {
        event.stopPropagation();
        setActiveFloor(room.floorId);
        setSelectedElement({ id: room.id, type: 'room' });
    };

    if (polygonShape) {
        return (
            <group onClick={handleSelect} raycast={room.locked ? ignoreLockedRaycast : undefined}>
                {showFloor && (isTransparent ? (
                    <mesh
                        position={[0, floorTopY, 0]}
                        rotation={[-Math.PI / 2, 0, 0]}
                        renderOrder={floorRenderOrder}
                    >
                        <shapeGeometry args={[polygonShape]} />
                        <meshStandardMaterial
                            color={room.color || '#dddddd'}
                            roughness={0.85}
                            side={THREE.DoubleSide}
                            {...getBlendMaterialProps(opacity)}
                        />
                    </mesh>
                ) : (
                    <group position={[0, floorTopY, 0]} rotation={[Math.PI / 2, 0, 0]}>
                        <mesh receiveShadow castShadow renderOrder={floorRenderOrder}>
                            <extrudeGeometry args={[polygonShape, { depth: FLOOR_THICKNESS, bevelEnabled: false }]} />
                            <meshStandardMaterial
                                color={room.color || '#dddddd'}
                                roughness={0.85}
                                side={THREE.DoubleSide}
                                {...getBlendMaterialProps(opacity)}
                            />
                        </mesh>
                    </group>
                ))}
                {room.showCeiling && (
                    isTransparent ? (
                        <mesh
                            position={[0, ceilingTopY, 0]}
                            rotation={[-Math.PI / 2, 0, 0]}
                            renderOrder={ceilingRenderOrder}
                        >
                            <shapeGeometry args={[polygonShape]} />
                            <meshStandardMaterial
                                color={ceilingColor}
                                roughness={0.72}
                                side={THREE.DoubleSide}
                                {...getBlendMaterialProps(opacity)}
                            />
                        </mesh>
                    ) : (
                        <group position={[0, ceilingTopY, 0]} rotation={[Math.PI / 2, 0, 0]}>
                            <mesh receiveShadow castShadow renderOrder={ceilingRenderOrder}>
                                <extrudeGeometry args={[polygonShape, { depth: CEILING_THICKNESS, bevelEnabled: false }]} />
                                <meshStandardMaterial
                                    color={ceilingColor}
                                    roughness={0.72}
                                    side={THREE.DoubleSide}
                                    {...getBlendMaterialProps(opacity)}
                                />
                            </mesh>
                        </group>
                    )
                )}
            </group>
        );
    }

    return (
        <>
            {showFloor && (canUseOpenings ? floorPatches : [{ x: room.x, y: room.y, width: room.width, height: room.height }]).map((patch, index) => (
                <group
                    key={`${room.id}-patch-${index}`}
                    position={[patch.x + patch.width / 2, 0, patch.y + patch.height / 2]}
                    rotation={[0, canUseOpenings ? 0 : rotationRadians, 0]}
                    onClick={handleSelect}
                    raycast={room.locked ? ignoreLockedRaycast : undefined}
                >
                    {isTransparent ? (
                        <mesh position={[0, floorTopY, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={floorRenderOrder}>
                            <planeGeometry args={[patch.width, patch.height]} />
                            <meshStandardMaterial
                                color={room.color || '#dddddd'}
                                roughness={0.85}
                                side={THREE.DoubleSide}
                                {...getBlendMaterialProps(opacity)}
                            />
                        </mesh>
                    ) : (
                        <Box args={[patch.width, FLOOR_THICKNESS, patch.height]} position={[0, floorTopY - FLOOR_THICKNESS / 2, 0]} castShadow receiveShadow renderOrder={floorRenderOrder}>
                            <meshStandardMaterial
                                color={room.color || '#dddddd'}
                                roughness={0.85}
                                {...getBlendMaterialProps(opacity)}
                            />
                        </Box>
                    )}
                </group>
            ))}
            {room.showCeiling && (canUseOpenings ? floorPatches : [{ x: room.x, y: room.y, width: room.width, height: room.height }]).map((patch, index) => (
                <group
                    key={`${room.id}-ceiling-${index}`}
                    position={[patch.x + patch.width / 2, 0, patch.y + patch.height / 2]}
                    rotation={[0, canUseOpenings ? 0 : rotationRadians, 0]}
                    raycast={room.locked ? ignoreLockedRaycast : undefined}
                    onClick={handleSelect}
                >
                    {isTransparent ? (
                        <mesh position={[0, ceilingTopY, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={ceilingRenderOrder}>
                            <planeGeometry args={[patch.width, patch.height]} />
                            <meshStandardMaterial
                                color={ceilingColor}
                                roughness={0.72}
                                side={THREE.DoubleSide}
                                {...getBlendMaterialProps(opacity)}
                            />
                        </mesh>
                    ) : (
                        <Box args={[patch.width, CEILING_THICKNESS, patch.height]} position={[0, ceilingCenterY, 0]} castShadow receiveShadow renderOrder={ceilingRenderOrder}>
                            <meshStandardMaterial
                                color={ceilingColor}
                                roughness={0.72}
                                {...getBlendMaterialProps(opacity)}
                            />
                        </Box>
                    )}
                </group>
            ))}
        </>
    );
}

function RoomWall3D({
    segment,
    floor,
    doorOpenings,
    locked = false
}: {
    segment: RoomWallSegment;
    floor: Floor;
    doorOpenings: WallOpening[];
    locked?: boolean;
}) {
    const { setActiveFloor, setSelectedElement } = useStore();
    const layer = (floor.layerSettings || defaultLayerSettings).walls;
    if (layer && !layer.visible) return null;
    if (!segment.visible) return null;
    const renderOrder = getFloorRenderBaseOrder(floor) + 14;

    return (
        <group
            raycast={locked ? ignoreLockedRaycast : undefined}
            onClick={(event) => {
                event.stopPropagation();
                setActiveFloor(segment.floorId);
                const roomId = segment.contributors[0]?.roomId;
                if (roomId) {
                    setSelectedElement({ id: roomId, type: 'room' });
                }
            }}
        >
            <WallWithOpenings
                start={segment.start}
                angle={segment.angle}
                baseElevation={floor.elevation}
                length={segment.length}
                height={segment.height}
                thickness={WALL_THICKNESS}
                color={ROOM_WALL_COLOR}
                opacity={layer?.opacity ?? 1}
                renderOrder={renderOrder}
                openings={doorOpenings}
            />
        </group>
    );
}

function Wall3D({
    wall,
    floor,
    doorOpenings
}: {
    wall: Wall;
    floor: Floor;
    doorOpenings: WallOpening[];
}) {
    const { setActiveFloor, setSelectedElement } = useStore();
    const segment = getWallSegment(wall);
    const height = wall.wallHeight || floor.height || DEFAULT_LEVEL_HEIGHT;
    const layer = (floor.layerSettings || defaultLayerSettings).walls;
    if (layer && !layer.visible) return null;
    const renderOrder = getFloorRenderBaseOrder(floor) + 15;

    return (
        <group
            raycast={wall.locked ? ignoreLockedRaycast : undefined}
            onClick={(event) => {
                event.stopPropagation();
                setActiveFloor(wall.floorId);
                setSelectedElement({ id: wall.id, type: 'wall' });
            }}
        >
            <WallWithOpenings
                start={segment.start}
                angle={segment.angle}
                baseElevation={floor.elevation}
                length={segment.length}
                height={height}
                thickness={wall.thickness || WALL_THICKNESS}
                color={wall.color || '#f0f0f0'}
                opacity={layer?.opacity ?? 1}
                renderOrder={renderOrder}
                openings={doorOpenings}
            />
        </group>
    );
}

function Door3D({ door, placement, floor, thickness }: { door: Door; placement: FittedDoorPlacement; floor: Floor; thickness?: number }) {
    const { setActiveFloor, setSelectedElement } = useStore();
    const doorLeafThickness = Math.min(thickness || WALL_THICKNESS, 0.08);
    const layer = (floor.layerSettings || defaultLayerSettings).doors;
    if (layer && !layer.visible) return null;
    const opacity = layer?.opacity ?? 1;
    const renderOrder = getFloorRenderBaseOrder(floor) + 18;

    return (
        <group
            position={[placement.center.x, floor.elevation, placement.center.y]}
            rotation={[0, -placement.angle, 0]}
            raycast={door.locked ? ignoreLockedRaycast : undefined}
            onClick={(event) => {
                event.stopPropagation();
                setActiveFloor(door.floorId);
                setSelectedElement({ id: door.id, type: 'door' });
            }}
        >
            <Box args={[placement.width, placement.doorHeight, doorLeafThickness]} position={[0, placement.doorHeight / 2, 0]} castShadow renderOrder={renderOrder}>
                <meshStandardMaterial
                    color={door.color || '#c78d54'}
                    metalness={0.05}
                    roughness={0.45}
                    {...getBlendMaterialProps(opacity)}
                />
            </Box>
        </group>
    );
}

function Cylinder3D({ cylinder, floor }: { cylinder: Cylinder; floor: Floor }) {
    const { setActiveFloor, setSelectedElement } = useStore();
    const height = cylinder.wallHeight || floor.height || DEFAULT_LEVEL_HEIGHT;
    const layer = (floor.layerSettings || defaultLayerSettings).cylinders;
    if (layer && !layer.visible) return null;
    const opacity = layer?.opacity ?? 1;
    const renderOrder = getFloorRenderBaseOrder(floor) + 22;
    return (
        <group
            position={[cylinder.x, floor.elevation + height / 2, cylinder.y]}
            raycast={cylinder.locked ? ignoreLockedRaycast : undefined}
            onClick={(event) => {
                event.stopPropagation();
                setActiveFloor(cylinder.floorId);
                setSelectedElement({ id: cylinder.id, type: 'cylinder' });
            }}
        >
            <CylinderShape args={[cylinder.radius, cylinder.radius, height, 32]} castShadow receiveShadow renderOrder={renderOrder}>
                <meshStandardMaterial
                    color={cylinder.color || '#f0f0f0'}
                    {...getBlendMaterialProps(opacity)}
                />
            </CylinderShape>
        </group>
    );
}

function Furniture3D({ item, floor }: { item: Furniture; floor: Floor }) {
    const { setActiveFloor, setSelectedElement } = useStore();
    const preset = getFurniturePreset(item.type);
    const color = item.color || preset.color;
    const width = item.width ?? preset.width;
    const height = item.height ?? preset.height;
    const depth = item.depth ?? preset.depth;
    const altitude = item.altitude || 0;
    const rotationY = -THREE.MathUtils.degToRad(item.rotation || 0);
    const legInsetX = Math.max(width * 0.14, 0.07);
    const legInsetZ = Math.max(depth * 0.14, 0.07);
    const legThickness = Math.max(Math.min(width, depth) * 0.08, 0.04);
    const softColor = new THREE.Color(color).offsetHSL(0, 0, 0.1);
    const darkColor = new THREE.Color(color).offsetHSL(0, 0, -0.12);
    const metalColor = '#dce5eb';
    const darkMetal = '#5f6874';
    const woodColor = '#8f6749';
    const paleWood = '#c9a283';
    const darkGlass = '#2d343e';
    const layer = (floor.layerSettings || defaultLayerSettings).furniture;
    if (layer && !layer.visible) return null;
    const opacity = layer?.opacity ?? 1;
    const groupRef = useRef<THREE.Group>(null);

    useEffect(() => {
        const group = groupRef.current;
        if (!group) return;
        group.traverse((obj) => {
            // @ts-ignore
            const material = obj.material as THREE.Material | undefined;
            if (material && 'opacity' in material) {
                // @ts-ignore
                material.opacity = opacity;
                // @ts-ignore
                material.transparent = opacity < 1;
                // @ts-ignore
                material.depthWrite = opacity >= 0.999;
                // @ts-ignore
                material.depthTest = true;
                // @ts-ignore
                material.premultipliedAlpha = opacity < 1;
                material.needsUpdate = true;
            }
        });
    }, [opacity]);

    return (
        <group
            ref={groupRef}
            position={[item.x + width / 2, floor.elevation + height / 2 + altitude, item.y + depth / 2]}
            rotation={[0, rotationY, 0]}
            raycast={item.locked ? ignoreLockedRaycast : undefined}
            onClick={(event) => {
                event.stopPropagation();
                setActiveFloor(item.floorId);
                setSelectedElement({ id: item.id, type: 'furniture' });
            }}
        >
            {item.type === 'sofa' && (
                <>
                    <Box args={[width, height * 0.42, depth]} position={[0, -height * 0.08, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.68} transparent={opacity < 1} opacity={opacity} />
                    </Box>
                    <Box args={[width, height * 0.28, depth * 0.28]} position={[0, height * 0.14, depth * 0.18]} castShadow receiveShadow>
                        <meshStandardMaterial color={softColor} roughness={0.6} transparent={opacity < 1} opacity={opacity} />
                    </Box>
                    <Box args={[width * 0.16, height * 0.26, depth * 0.72]} position={[-width * 0.42, height * 0.02, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={darkColor} roughness={0.65} transparent={opacity < 1} opacity={opacity} />
                    </Box>
                    <Box args={[width * 0.16, height * 0.26, depth * 0.72]} position={[width * 0.42, height * 0.02, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={darkColor} roughness={0.65} transparent={opacity < 1} opacity={opacity} />
                    </Box>
                </>
            )}

            {item.type === 'bed' && (
                <>
                    <Box args={[width, height * 0.32, depth]} position={[0, -height * 0.1, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.7} />
                    </Box>
                    <Box args={[width * 0.98, height * 0.14, depth * 0.94]} position={[0, height * 0.02, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#eef6ff" roughness={0.82} />
                    </Box>
                    <Box args={[width, height * 0.36, depth * 0.08]} position={[0, height * 0.12, -depth * 0.46]} castShadow receiveShadow>
                        <meshStandardMaterial color="#9cc1df" roughness={0.58} />
                    </Box>
                </>
            )}

            {item.type === 'plant' && (
                <>
                    <CylinderShape args={[width * 0.3, width * 0.24, height * 0.28, 18]} position={[0, -height * 0.26, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#8a5f43" roughness={0.75} />
                    </CylinderShape>
                    <CylinderShape args={[width * 0.46, width * 0.18, height * 0.72, 18]} position={[0, height * 0.08, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.72} />
                    </CylinderShape>
                </>
            )}

            {item.type === 'cinema_screen' && (
                <>
                    <Box args={[width, height * 0.68, Math.max(depth * 0.22, 0.04)]} position={[0, height * 0.12, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#1f2732" roughness={0.44} metalness={0.08} transparent={opacity < 1} opacity={opacity} />
                    </Box>
                    <Box args={[width * 0.9, height * 0.56, Math.max(depth * 0.1, 0.03)]} position={[0, height * 0.12, depth * 0.02]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} emissive="#bcd8f8" emissiveIntensity={0.28} roughness={0.24} transparent={opacity < 1} opacity={opacity} />
                    </Box>
                    <Box args={[width * 0.05, height * 0.24, Math.max(depth * 0.12, 0.04)]} position={[0, -height * 0.24, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#d1dae2" roughness={0.34} metalness={0.22} transparent={opacity < 1} opacity={opacity} />
                    </Box>
                    <Box args={[width * 0.38, height * 0.05, depth * 0.7]} position={[0, -height * 0.36, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#677280" roughness={0.46} metalness={0.12} transparent={opacity < 1} opacity={opacity} />
                    </Box>
                    <Box args={[width * 0.12, height * 0.04, depth * 0.82]} position={[-width * 0.34, -height * 0.4, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#59626d" roughness={0.48} metalness={0.14} transparent={opacity < 1} opacity={opacity} />
                    </Box>
                    <Box args={[width * 0.12, height * 0.04, depth * 0.82]} position={[width * 0.34, -height * 0.4, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#59626d" roughness={0.48} metalness={0.14} transparent={opacity < 1} opacity={opacity} />
                    </Box>
                </>
            )}

            {item.type === 'dining_table' && (
                <>
                    <Box args={[width, height * 0.12, depth]} position={[0, height * 0.24, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.62} />
                    </Box>
                    {[
                        [-width / 2 + legInsetX, -height * 0.1, -depth / 2 + legInsetZ],
                        [width / 2 - legInsetX, -height * 0.1, -depth / 2 + legInsetZ],
                        [-width / 2 + legInsetX, -height * 0.1, depth / 2 - legInsetZ],
                        [width / 2 - legInsetX, -height * 0.1, depth / 2 - legInsetZ]
                    ].map((position, index) => (
                        <Box key={index} args={[legThickness, height * 0.58, legThickness]} position={position as [number, number, number]} castShadow receiveShadow>
                            <meshStandardMaterial color={woodColor} roughness={0.72} />
                        </Box>
                    ))}
                </>
            )}

            {item.type === 'round_table' && (
                <>
                    <CylinderShape args={[Math.min(width, depth) * 0.48, Math.min(width, depth) * 0.48, height * 0.1, 28]} position={[0, height * 0.24, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.56} />
                    </CylinderShape>
                    <CylinderShape args={[Math.min(width, depth) * 0.08, Math.min(width, depth) * 0.1, height * 0.56, 20]} position={[0, -height * 0.06, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={metalColor} metalness={0.22} roughness={0.34} />
                    </CylinderShape>
                    <CylinderShape args={[Math.min(width, depth) * 0.28, Math.min(width, depth) * 0.32, height * 0.04, 24]} position={[0, -height * 0.32, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={darkMetal} metalness={0.2} roughness={0.36} />
                    </CylinderShape>
                </>
            )}

            {item.type === 'dining_chair' && (
                <>
                    <Box args={[width * 0.7, height * 0.08, depth * 0.7]} position={[0, -height * 0.02, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.64} />
                    </Box>
                    <Box args={[width * 0.74, height * 0.34, depth * 0.08]} position={[0, height * 0.22, -depth * 0.28]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.64} />
                    </Box>
                    {[
                        [-width * 0.22, -height * 0.26, -depth * 0.22],
                        [width * 0.22, -height * 0.26, -depth * 0.22],
                        [-width * 0.22, -height * 0.26, depth * 0.22],
                        [width * 0.22, -height * 0.26, depth * 0.22]
                    ].map((position, index) => (
                        <Box key={index} args={[legThickness * 0.85, height * 0.5, legThickness * 0.85]} position={position as [number, number, number]} castShadow receiveShadow>
                            <meshStandardMaterial color={darkMetal} roughness={0.56} />
                        </Box>
                    ))}
                </>
            )}

            {item.type === 'bar_stool' && (
                <>
                    <CylinderShape args={[width * 0.42, width * 0.42, height * 0.08, 20]} position={[0, height * 0.18, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.56} />
                    </CylinderShape>
                    <CylinderShape args={[width * 0.07, width * 0.07, height * 0.58, 16]} position={[0, -height * 0.08, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={metalColor} metalness={0.42} roughness={0.35} />
                    </CylinderShape>
                    <CylinderShape args={[width * 0.34, width * 0.34, height * 0.03, 20]} position={[0, -height * 0.2, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={metalColor} metalness={0.38} roughness={0.32} />
                    </CylinderShape>
                </>
            )}

            {item.type === 'booth_seat' && (
                <>
                    <Box args={[width, height * 0.28, depth * 0.56]} position={[0, -height * 0.16, depth * 0.12]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.72} />
                    </Box>
                    <Box args={[width, height * 0.44, depth * 0.14]} position={[0, height * 0.1, -depth * 0.26]} castShadow receiveShadow>
                        <meshStandardMaterial color={darkColor} roughness={0.68} />
                    </Box>
                    <Box args={[width, height * 0.06, depth]} position={[0, -height * 0.35, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={paleWood} roughness={0.72} />
                    </Box>
                </>
            )}

            {item.type === 'corner_booth' && (
                <>
                    <Box args={[width, height * 0.08, depth]} position={[0, -height * 0.36, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={paleWood} roughness={0.72} />
                    </Box>
                    <Box args={[width * 0.72, height * 0.26, depth * 0.34]} position={[-width * 0.08, -height * 0.16, depth * 0.2]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.72} />
                    </Box>
                    <Box args={[width * 0.34, height * 0.26, depth * 0.72]} position={[width * 0.2, -height * 0.16, -depth * 0.08]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.72} />
                    </Box>
                    <Box args={[width * 0.72, height * 0.42, depth * 0.12]} position={[-width * 0.08, height * 0.1, -depth * 0.2]} castShadow receiveShadow>
                        <meshStandardMaterial color={darkColor} roughness={0.68} />
                    </Box>
                    <Box args={[width * 0.12, height * 0.42, depth * 0.72]} position={[-width * 0.2, height * 0.1, -depth * 0.08]} castShadow receiveShadow>
                        <meshStandardMaterial color={darkColor} roughness={0.68} />
                    </Box>
                </>
            )}

            {item.type === 'service_counter' && (
                <>
                    <Box args={[width, height * 0.82, depth]} position={[0, -height * 0.03, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.54} />
                    </Box>
                    <Box args={[width * 1.02, height * 0.08, depth * 1.04]} position={[0, height * 0.38, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={metalColor} metalness={0.35} roughness={0.28} />
                    </Box>
                    <Box args={[width * 0.28, height * 0.5, depth * 0.04]} position={[-width * 0.22, 0, depth * 0.49]} castShadow receiveShadow>
                        <meshStandardMaterial color="#99a4b8" roughness={0.44} />
                    </Box>
                    <Box args={[width * 0.28, height * 0.5, depth * 0.04]} position={[width * 0.22, 0, depth * 0.49]} castShadow receiveShadow>
                        <meshStandardMaterial color="#99a4b8" roughness={0.44} />
                    </Box>
                </>
            )}

            {item.type === 'host_stand' && (
                <>
                    <Box args={[width * 0.82, height * 0.74, depth * 0.74]} position={[0, -height * 0.06, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.58} />
                    </Box>
                    <Box args={[width, height * 0.08, depth]} position={[0, height * 0.34, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={paleWood} roughness={0.5} />
                    </Box>
                    <Box args={[width * 0.7, height * 0.1, depth * 0.18]} position={[0, height * 0.16, -depth * 0.24]} castShadow receiveShadow>
                        <meshStandardMaterial color={softColor} roughness={0.46} />
                    </Box>
                </>
            )}

            {item.type === 'prep_table' && (
                <>
                    <Box args={[width, height * 0.08, depth]} position={[0, height * 0.28, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} metalness={0.44} roughness={0.28} />
                    </Box>
                    <Box args={[width * 0.84, height * 0.05, depth * 0.7]} position={[0, -height * 0.02, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#a4b4bf" metalness={0.4} roughness={0.3} />
                    </Box>
                    {[
                        [-width / 2 + legInsetX, -height * 0.16, -depth / 2 + legInsetZ],
                        [width / 2 - legInsetX, -height * 0.16, -depth / 2 + legInsetZ],
                        [-width / 2 + legInsetX, -height * 0.16, depth / 2 - legInsetZ],
                        [width / 2 - legInsetX, -height * 0.16, depth / 2 - legInsetZ]
                    ].map((position, index) => (
                        <Box key={index} args={[legThickness, height * 0.7, legThickness]} position={position as [number, number, number]} castShadow receiveShadow>
                            <meshStandardMaterial color={metalColor} metalness={0.42} roughness={0.28} />
                        </Box>
                    ))}
                </>
            )}

            {item.type === 'stove_range' && (
                <>
                    <Box args={[width, height * 0.88, depth]} position={[0, -height * 0.02, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} metalness={0.34} roughness={0.38} />
                    </Box>
                    {[
                        [-width * 0.22, height * 0.28, -depth * 0.2],
                        [width * 0.22, height * 0.28, -depth * 0.2],
                        [-width * 0.22, height * 0.28, depth * 0.2],
                        [width * 0.22, height * 0.28, depth * 0.2]
                    ].map((position, index) => (
                        <CylinderShape key={index} args={[width * 0.12, width * 0.12, height * 0.03, 18]} position={position as [number, number, number]} castShadow receiveShadow>
                            <meshStandardMaterial color="#20262f" roughness={0.36} />
                        </CylinderShape>
                    ))}
                    <Box args={[width * 0.8, height * 0.06, depth * 0.04]} position={[0, height * 0.39, -depth * 0.44]} castShadow receiveShadow>
                        <meshStandardMaterial color={metalColor} metalness={0.38} roughness={0.26} />
                    </Box>
                </>
            )}

            {item.type === 'fryer_station' && (
                <>
                    <Box args={[width, height * 0.88, depth]} position={[0, -height * 0.02, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} metalness={0.3} roughness={0.34} />
                    </Box>
                    <Box args={[width * 0.28, height * 0.16, depth * 0.28]} position={[-width * 0.18, height * 0.26, -depth * 0.04]} castShadow receiveShadow>
                        <meshStandardMaterial color="#505962" roughness={0.3} />
                    </Box>
                    <Box args={[width * 0.28, height * 0.16, depth * 0.28]} position={[width * 0.18, height * 0.26, -depth * 0.04]} castShadow receiveShadow>
                        <meshStandardMaterial color="#505962" roughness={0.3} />
                    </Box>
                    {[-width * 0.2, -width * 0.08, width * 0.08, width * 0.2].map((x, index) => (
                        <Box key={index} args={[width * 0.03, height * 0.2, depth * 0.03]} position={[x, height * 0.42, -depth * 0.28]} castShadow receiveShadow>
                            <meshStandardMaterial color={metalColor} metalness={0.42} roughness={0.24} />
                        </Box>
                    ))}
                    <Box args={[width * 0.56, height * 0.04, depth * 0.12]} position={[0, -height * 0.04, depth * 0.26]} castShadow receiveShadow>
                        <meshStandardMaterial color={metalColor} metalness={0.4} roughness={0.24} />
                    </Box>
                </>
            )}

            {item.type === 'oven_unit' && (
                <>
                    <Box args={[width, height, depth]} position={[0, 0, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} metalness={0.28} roughness={0.34} />
                    </Box>
                    <Box args={[width * 0.76, height * 0.32, depth * 0.08]} position={[0, -height * 0.08, depth * 0.47]} castShadow receiveShadow>
                        <meshStandardMaterial color={darkGlass} metalness={0.08} roughness={0.18} />
                    </Box>
                    {[-0.22, -0.07, 0.08, 0.23].map((offset, index) => (
                        <CylinderShape key={index} args={[width * 0.035, width * 0.035, depth * 0.05, 14]} position={[width * offset, height * 0.34, depth * 0.42]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
                            <meshStandardMaterial color={metalColor} metalness={0.4} roughness={0.24} />
                        </CylinderShape>
                    ))}
                    <Box args={[width * 0.58, height * 0.03, depth * 0.05]} position={[0, -height * 0.28, depth * 0.45]} castShadow receiveShadow>
                        <meshStandardMaterial color={metalColor} metalness={0.38} roughness={0.24} />
                    </Box>
                </>
            )}

            {item.type === 'double_sink' && (
                <>
                    <Box args={[width, height * 0.86, depth]} position={[0, -height * 0.04, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} metalness={0.32} roughness={0.34} />
                    </Box>
                    <Box args={[width * 0.28, height * 0.12, depth * 0.34]} position={[-width * 0.18, height * 0.28, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#73848e" roughness={0.32} />
                    </Box>
                    <Box args={[width * 0.28, height * 0.12, depth * 0.34]} position={[width * 0.18, height * 0.28, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#73848e" roughness={0.32} />
                    </Box>
                    <CylinderShape args={[width * 0.04, width * 0.04, height * 0.18, 14]} position={[0, height * 0.36, -depth * 0.2]} castShadow receiveShadow>
                        <meshStandardMaterial color={metalColor} metalness={0.46} roughness={0.24} />
                    </CylinderShape>
                </>
            )}

            {item.type === 'fridge_display' && (
                <>
                    <Box args={[width, height, depth]} position={[0, 0, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} metalness={0.18} roughness={0.24} />
                    </Box>
                    <Box args={[width * 0.04, height * 0.7, depth * 0.04]} position={[-width * 0.16, 0, depth * 0.48]} castShadow receiveShadow>
                        <meshStandardMaterial color="#86a0b0" metalness={0.34} roughness={0.24} />
                    </Box>
                    <Box args={[width * 0.04, height * 0.52, depth * 0.04]} position={[width * 0.16, -height * 0.08, depth * 0.48]} castShadow receiveShadow>
                        <meshStandardMaterial color="#86a0b0" metalness={0.34} roughness={0.24} />
                    </Box>
                </>
            )}

            {item.type === 'display_case' && (
                <>
                    <Box args={[width, height * 0.38, depth]} position={[0, -height * 0.2, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#55606f" roughness={0.42} />
                    </Box>
                    <Box args={[width * 0.96, height * 0.42, depth * 0.96]} position={[0, height * 0.16, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} transparent opacity={0.42} roughness={0.08} metalness={0.08} />
                    </Box>
                    <Box args={[width * 0.82, height * 0.03, depth * 0.74]} position={[0, -height * 0.02, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#dce5eb" metalness={0.24} roughness={0.22} />
                    </Box>
                </>
            )}

            {item.type === 'espresso_station' && (
                <>
                    <Box args={[width, height * 0.62, depth * 0.7]} position={[0, 0, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.4} metalness={0.2} />
                    </Box>
                    <Box args={[width * 0.18, height * 0.2, depth * 0.1]} position={[-width * 0.22, -height * 0.06, depth * 0.22]} castShadow receiveShadow>
                        <meshStandardMaterial color={metalColor} metalness={0.34} roughness={0.24} />
                    </Box>
                    <Box args={[width * 0.18, height * 0.2, depth * 0.1]} position={[width * 0.22, -height * 0.06, depth * 0.22]} castShadow receiveShadow>
                        <meshStandardMaterial color={metalColor} metalness={0.34} roughness={0.24} />
                    </Box>
                    <Box args={[width * 0.7, height * 0.06, depth * 0.78]} position={[0, height * 0.22, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#c99d6c" roughness={0.46} />
                    </Box>
                </>
            )}

            {item.type === 'bakery_rack' && (
                <>
                    {[
                        [-width * 0.4, 0, -depth * 0.36],
                        [width * 0.4, 0, -depth * 0.36],
                        [-width * 0.4, 0, depth * 0.36],
                        [width * 0.4, 0, depth * 0.36]
                    ].map((position, index) => (
                        <Box key={index} args={[legThickness, height * 0.92, legThickness]} position={position as [number, number, number]} castShadow receiveShadow>
                            <meshStandardMaterial color={metalColor} metalness={0.42} roughness={0.22} />
                        </Box>
                    ))}
                    {[-0.28, -0.08, 0.12, 0.32].map((offset, index) => (
                        <Box key={index} args={[width * 0.88, height * 0.03, depth * 0.84]} position={[0, height * offset, 0]} castShadow receiveShadow>
                            <meshStandardMaterial color={color} metalness={0.3} roughness={0.24} />
                        </Box>
                    ))}
                </>
            )}

            {item.type === 'salad_bar' && (
                <>
                    <Box args={[width, height * 0.56, depth]} position={[0, -height * 0.16, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.48} />
                    </Box>
                    <Box args={[width * 0.92, height * 0.22, depth * 0.88]} position={[0, height * 0.16, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#bfe7da" transparent opacity={0.42} roughness={0.08} metalness={0.06} />
                    </Box>
                    <Box args={[width * 0.22, height * 0.02, depth * 0.56]} position={[-width * 0.26, height * 0.28, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#dbeee6" roughness={0.26} />
                    </Box>
                    <Box args={[width * 0.22, height * 0.02, depth * 0.56]} position={[0, height * 0.28, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#dbeee6" roughness={0.26} />
                    </Box>
                    <Box args={[width * 0.22, height * 0.02, depth * 0.56]} position={[width * 0.26, height * 0.28, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color="#dbeee6" roughness={0.26} />
                    </Box>
                </>
            )}

            {item.type === 'beer_tap' && (
                <>
                    <Box args={[width, height * 0.62, depth]} position={[0, -height * 0.1, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={color} roughness={0.56} />
                    </Box>
                    <Box args={[width * 1.02, height * 0.08, depth * 1.02]} position={[0, height * 0.26, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={paleWood} roughness={0.46} />
                    </Box>
                    {[-width * 0.18, 0, width * 0.18].map((x, index) => (
                        <group key={index} position={[x, height * 0.2, -depth * 0.04]}>
                            <CylinderShape args={[width * 0.05, width * 0.05, height * 0.34, 16]} castShadow receiveShadow>
                                <meshStandardMaterial color={metalColor} metalness={0.44} roughness={0.22} />
                            </CylinderShape>
                            <Box args={[width * 0.12, height * 0.06, depth * 0.08]} position={[0, height * 0.1, depth * 0.08]} castShadow receiveShadow>
                                <meshStandardMaterial color="#f0cf68" roughness={0.28} />
                            </Box>
                        </group>
                    ))}
                </>
            )}
        </group>
    );
}

function Surface3D({ surface, floor, rooms }: { surface: Surface; floor: Floor; rooms: Room[] }) {
    const { setActiveFloor, setSelectedElement } = useStore();
    const depth = surface.depth || 0.1;
    const altitude = surface.altitude || 0;
    const layer = (floor.layerSettings || defaultLayerSettings).surfaces;
    if (layer && !layer.visible) return null;
    const opacity = layer?.opacity ?? 1;
    const isTransparent = usesTransparentPass(opacity);
    const renderOrder = getFloorRenderBaseOrder(floor) + SURFACE_RENDER_ORDER;
    const isLevelSurface = Math.abs(altitude) <= 0.001;
    const surfaceBaseY = isLevelSurface
        ? floor.elevation - LEVEL_SURFACE_OFFSET
        : floor.elevation + altitude + SURFACE_CLEARANCE;

    const shape = useMemo(() => {
        if (!surface.points || surface.points.length < 3) return null;

        const nextShape = new THREE.Shape();
        surface.points.forEach((point, index) => {
            if (index === 0) {
                nextShape.moveTo(point.x, point.y);
                return;
            }
            nextShape.lineTo(point.x, point.y);
        });

        const outerVectors = surface.points.map((point) => new THREE.Vector2(point.x, point.y));
        const outerIsClockwise = THREE.ShapeUtils.isClockWise(outerVectors);
        const candidateRooms = isLevelSurface
            ? rooms.filter((room) => {
                const polygon = getRoomPolygon(room);
                return polygon.length >= 3 && isPolygonInsidePolygon(polygon, surface.points);
            })
            : [];

        candidateRooms.forEach((room) => {
            const roomPolygon = getRoomPolygon(room);
            const roomVectors = roomPolygon.map((point) => new THREE.Vector2(point.x, point.y));
            const roomIsClockwise = THREE.ShapeUtils.isClockWise(roomVectors);
            nextShape.holes.push(createShapePath(roomPolygon, roomIsClockwise === outerIsClockwise));
        });

        return nextShape;
    }, [isLevelSurface, rooms, surface.points]);

    if (!shape) return null;

    return (
        <group
            position={[0, surfaceBaseY, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            raycast={surface.locked ? ignoreLockedRaycast : undefined}
            onClick={(event) => {
                event.stopPropagation();
                setActiveFloor(surface.floorId);
                setSelectedElement({ id: surface.id, type: 'surface' });
            }}
        >
            {isTransparent ? (
                <mesh renderOrder={renderOrder}>
                    <shapeGeometry args={[shape]} />
                    <meshStandardMaterial
                        color={surface.color || '#cccccc'}
                        side={THREE.DoubleSide}
                        {...getBlendMaterialProps(opacity)}
                    />
                </mesh>
            ) : (
                <mesh receiveShadow castShadow renderOrder={renderOrder}>
                    <extrudeGeometry args={[shape, { depth, bevelEnabled: false }]} />
                    <meshStandardMaterial
                        color={surface.color || '#cccccc'}
                        side={THREE.DoubleSide}
                        {...getBlendMaterialProps(opacity)}
                    />
                </mesh>
                )}
        </group>
    );
}

function Ruler3D({ ruler, floor }: { ruler: Ruler; floor: Floor }) {
    const { setActiveFloor, setSelectedElement } = useStore();
    const layer = (floor.layerSettings || defaultLayerSettings).rulers;
    if (layer && !layer.visible) return null;
    const opacity = layer?.opacity ?? 1;
    const renderOrder = getFloorRenderBaseOrder(floor) + RULER_RENDER_ORDER;

    const dx = ruler.endX - ruler.startX;
    const dz = ruler.endY - ruler.startY;
    const length = Math.hypot(dx, dz);
    if (length <= 0.001) return null;

    return (
        <group
            position={[(ruler.startX + ruler.endX) / 2, floor.elevation + SURFACE_CLEARANCE + 0.04, (ruler.startY + ruler.endY) / 2]}
            rotation={[0, -Math.atan2(dz, dx), 0]}
            raycast={ruler.locked ? ignoreLockedRaycast : undefined}
            onClick={(event) => {
                event.stopPropagation();
                setActiveFloor(ruler.floorId);
                setSelectedElement({ id: ruler.id, type: 'ruler' });
            }}
        >
            <Box args={[length, 0.028, 0.06]} castShadow receiveShadow renderOrder={renderOrder}>
                <meshStandardMaterial
                    color={ruler.color || '#7dd3fc'}
                    emissive={ruler.color || '#7dd3fc'}
                    emissiveIntensity={0.18}
                    {...getBlendMaterialProps(opacity)}
                />
            </Box>
            <Box args={[0.08, 0.08, 0.08]} position={[-length / 2, 0, 0]} castShadow receiveShadow renderOrder={renderOrder}>
                <meshStandardMaterial color="#e8f3ff" {...getBlendMaterialProps(opacity)} />
            </Box>
            <Box args={[0.08, 0.08, 0.08]} position={[length / 2, 0, 0]} castShadow receiveShadow renderOrder={renderOrder}>
                <meshStandardMaterial color="#e8f3ff" {...getBlendMaterialProps(opacity)} />
            </Box>
        </group>
    );
}

function Stair3D({ stair, floor, targetFloor }: { stair: Stair; floor: Floor; targetFloor: Floor }) {
    const { setActiveFloor, setSelectedElement } = useStore();
    const elevationDelta = targetFloor.elevation - floor.elevation;
    const layer = (floor.layerSettings || defaultLayerSettings).stairs;
    if (layer && !layer.visible) return null;
    const opacity = layer?.opacity ?? 1;
    const renderOrder = getFloorRenderBaseOrder(floor) + 24;

    if (Math.abs(elevationDelta) < 0.1) {
        return null;
    }

    const stairKind = getStairKind(stair);
    const stepCount = Math.max(
        stairKind === 'spiral' ? 8 : 6,
        Math.round(stair.stepCount || 0),
        Math.ceil(Math.abs(elevationDelta) / 0.2)
    );
    const treadThickness = 0.08;
    const baseX = stair.x + stair.width / 2;
    const baseZ = stair.y + stair.height / 2;

    if (stairKind === 'spiral') {
        const turns = Math.max(stair.turns || 1.25, 0.5);
        const spin = stair.spin || 'clockwise';
        const sweep = Math.PI * 2 * turns * (spin === 'clockwise' ? -1 : 1);
        const startAngle = THREE.MathUtils.degToRad(stair.startAngle ?? directionToAngle(stair.direction));
        const risePerStep = elevationDelta / stepCount;
        const outerRadiusX = Math.max(stair.width / 2 - 0.06, 0.45);
        const outerRadiusZ = Math.max(stair.height / 2 - 0.06, 0.45);
        const coreRadius = clampSpiralCoreRadius(stair.width, stair.height, stair.coreRadius);
        const radialSpan = Math.max(Math.min(outerRadiusX, outerRadiusZ) - coreRadius, 0.34);
        const midRadiusX = coreRadius + (outerRadiusX - coreRadius) * 0.5;
        const midRadiusZ = coreRadius + (outerRadiusZ - coreRadius) * 0.5;
        const averageRadius = (midRadiusX + midRadiusZ) / 2;
        const tangentialLength = Math.max((Math.abs(sweep) * averageRadius) / stepCount * 0.9, 0.26);

        return (
            <group
                position={[baseX, floor.elevation, baseZ]}
                raycast={stair.locked ? ignoreLockedRaycast : undefined}
                onClick={(event) => {
                    event.stopPropagation();
                    setActiveFloor(stair.floorId);
                    setSelectedElement({ id: stair.id, type: 'stair' });
                }}
            >
                <CylinderShape
                    args={[Math.max(coreRadius * 0.26, 0.08), Math.max(coreRadius * 0.32, 0.1), Math.abs(elevationDelta) + treadThickness * 1.5, 24]}
                    position={[0, elevationDelta / 2, 0]}
                    castShadow
                    receiveShadow
                    renderOrder={renderOrder}
                >
                    <meshStandardMaterial
                        color="#d8dee8"
                        roughness={0.45}
                        metalness={0.15}
                        {...getBlendMaterialProps(opacity)}
                    />
                </CylinderShape>

                {Array.from({ length: stepCount }).map((_, index) => {
                    const t = (index + 0.5) / stepCount;
                    const angle = startAngle + sweep * t;
                    const x = Math.cos(angle) * midRadiusX;
                    const z = Math.sin(angle) * midRadiusZ;
                    const tangentX = -outerRadiusX * Math.sin(angle);
                    const tangentZ = outerRadiusZ * Math.cos(angle);
                    const rotationY = Math.atan2(-tangentZ, tangentX);
                    const y = risePerStep * (index + 1) - treadThickness / 2;

                    return (
                        <Box
                            key={`${stair.id}-spiral-step-${index}`}
                            args={[tangentialLength, treadThickness, radialSpan]}
                            position={[x, y, z]}
                            rotation={[0, rotationY, 0]}
                            castShadow
                            receiveShadow
                            renderOrder={renderOrder}
                        >
                            <meshStandardMaterial
                                color={stair.color || '#ff9f68'}
                                roughness={0.52}
                                metalness={0.04}
                                {...getBlendMaterialProps(opacity)}
                            />
                        </Box>
                    );
                })}
            </group>
        );
    }

    const climbsOnX = stair.direction === 'east' || stair.direction === 'west';
    const runLength = climbsOnX ? stair.width : stair.height;
    const crossLength = climbsOnX ? stair.height : stair.width;
    const treadDepth = Math.max(runLength / stepCount, 0.22);
    const risePerStep = elevationDelta / stepCount;

    return (
        <group
            position={[baseX, floor.elevation, baseZ]}
            raycast={stair.locked ? ignoreLockedRaycast : undefined}
            onClick={(event) => {
                event.stopPropagation();
                setActiveFloor(stair.floorId);
                setSelectedElement({ id: stair.id, type: 'stair' });
            }}
        >
            {Array.from({ length: stepCount }).map((_, index) => {
                const offsetFromStart = runLength / 2 - treadDepth * (index + 0.5);
                const signedOffset = stair.direction === 'north' || stair.direction === 'west'
                    ? offsetFromStart
                    : -offsetFromStart;
                const y = risePerStep * (index + 1) - treadThickness / 2;

                const position: [number, number, number] = climbsOnX
                    ? [signedOffset, y, 0]
                    : [0, y, signedOffset];
                const args: [number, number, number] = climbsOnX
                    ? [treadDepth, treadThickness, crossLength]
                    : [crossLength, treadThickness, treadDepth];

                return (
                    <Box key={index} args={args} position={position} castShadow receiveShadow renderOrder={renderOrder}>
                        <meshStandardMaterial
                            color={stair.color || '#ffd166'}
                            roughness={0.55}
                            {...getBlendMaterialProps(opacity)}
                        />
                    </Box>
                );
            })}
        </group>
    );
}

function SceneNavigation({
    controlsRef,
    bounds,
    fitRequestToken
}: {
    controlsRef: React.RefObject<OrbitControlsImpl>;
    bounds: THREE.Box3;
    fitRequestToken: number;
}) {
    const { camera } = useThree();
    const hasInitialFit = useRef(false);
    const keysRef = useRef<Record<string, boolean>>({});

    useEffect(() => {
        const controls = controlsRef.current;
        const perspectiveCamera = camera as THREE.PerspectiveCamera;
        if (!controls || hasInitialFit.current) return;

        fitCameraToBounds(perspectiveCamera, controls, bounds);
        hasInitialFit.current = true;
    }, [bounds, camera, controlsRef]);

    useEffect(() => {
        if (fitRequestToken === 0) return;
        const controls = controlsRef.current;
        if (!controls) return;
        fitCameraToBounds(camera as THREE.PerspectiveCamera, controls, bounds);
    }, [bounds, camera, controlsRef, fitRequestToken]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const isTypingTarget = target?.tagName === 'INPUT'
                || target?.tagName === 'TEXTAREA'
                || target?.tagName === 'SELECT'
                || !!target?.isContentEditable;

            if (isTypingTarget) return;

            if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'KeyF'].includes(event.code)) {
                event.preventDefault();
            }

            if (event.code === 'KeyF') {
                const controls = controlsRef.current;
                if (!controls) return;
                fitCameraToBounds(camera as THREE.PerspectiveCamera, controls, bounds);
                return;
            }

            keysRef.current[event.code] = true;
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            keysRef.current[event.code] = false;
        };

        const handleBlur = () => {
            keysRef.current = {};
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', handleBlur);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', handleBlur);
        };
    }, [bounds, camera, controlsRef]);

    useFrame((_, delta) => {
        const controls = controlsRef.current;
        if (!controls) return;

        const keys = keysRef.current;
        const movingForward = keys.KeyW || keys.ArrowUp;
        const movingBackward = keys.KeyS || keys.ArrowDown;
        const movingLeft = keys.KeyA || keys.ArrowLeft;
        const movingRight = keys.KeyD || keys.ArrowRight;

        if (!movingForward && !movingBackward && !movingLeft && !movingRight) {
            controls.update();
            return;
        }

        const move = new THREE.Vector3();
        const viewDirection = controls.target.clone().sub(camera.position);
        viewDirection.y = 0;
        if (viewDirection.lengthSq() < 0.0001) {
            viewDirection.set(0, 0, -1);
        } else {
            viewDirection.normalize();
        }

        const right = new THREE.Vector3().crossVectors(viewDirection, WORLD_UP).normalize();
        if (movingForward) move.add(viewDirection);
        if (movingBackward) move.sub(viewDirection);
        if (movingRight) move.add(right);
        if (movingLeft) move.sub(right);

        if (move.lengthSq() > 0) {
            const size = bounds.getSize(new THREE.Vector3());
            const movementSpeed = (keys.ShiftLeft || keys.ShiftRight ? 12 : 5) * Math.max(size.length() * 0.08, 1) * delta;
            move.normalize().multiplyScalar(movementSpeed);
            camera.position.add(move);
            controls.target.add(move);
        }

        controls.update();
    });

    return null;
}

export default function Canvas3D() {
    const { floors, rooms, furniture, walls, cylinders, doors, surfaces, stairs, rulers, activeFloorId, setActiveFloor, setVisibleFloors, setSelectedElement } = useStore();
    const [fitRequestToken, setFitRequestToken] = useState(0);
    const controlsRef = useRef<OrbitControlsImpl>(null);

    const sortedFloors = useMemo(
        () => [...floors].sort((a, b) => a.elevation - b.elevation),
        [floors]
    );
    const visibleFloors = floors.filter((floor) => floor.visible);
    const visibleFloorIds = visibleFloors.map((floor) => floor.id);
    const floorMap = useMemo(
        () => new Map(visibleFloors.map((floor) => [floor.id, floor])),
        [visibleFloors]
    );

    const visibleRooms = rooms.filter((room) => floorMap.has(room.floorId));
    const visibleWalls = walls.filter((wall) => floorMap.has(wall.floorId));
    const visibleCylinders = cylinders.filter((cylinder) => floorMap.has(cylinder.floorId));
    const visibleFurniture = furniture.filter((item) => floorMap.has(item.floorId));
    const visibleSurfaces = surfaces.filter((surface) => floorMap.has(surface.floorId));
    const visibleStairs = stairs.filter((stair) => floorMap.has(stair.floorId) && floorMap.has(stair.targetFloorId));
    const visibleRulers = rulers.filter((ruler) => floorMap.has(ruler.floorId));
    const lockedRoomIds = useMemo(
        () => new Set(visibleRooms.filter((room) => room.locked).map((room) => room.id)),
        [visibleRooms]
    );
    const roomWallSegments = useMemo(
        () => subtractWallOverlapsFromRoomSegments(buildRoomWallSegments(visibleRooms, visibleFloors), visibleWalls),
        [visibleFloors, visibleRooms, visibleWalls]
    );
    const visibleDoors = useMemo(
        () => doors
            .map((door) => {
                const placement = resolveDoorPlacement(door, rooms, walls);
                if (!placement || !floorMap.has(placement.floorId)) return null;
                return { door, placement };
            })
            .filter((entry): entry is { door: Door; placement: FittedDoorPlacement } => entry !== null),
        [doors, floorMap, rooms, walls]
    );
    const stairOpeningsByFloor = useMemo(() => {
        const nextMap = new Map<string, Rect2D[]>();

        visibleStairs.forEach((stair) => {
            const openingFloorId = getStairOpeningFloorId(stair, floorMap);
            if (!openingFloorId) return;

            const openings = nextMap.get(openingFloorId) || [];
            openings.push({
                x: stair.x,
                y: stair.y,
                width: stair.width,
                height: stair.height
            });
            nextMap.set(openingFloorId, openings);
        });

        return nextMap;
    }, [floorMap, visibleStairs]);
    const roomFloorOpeningsMap = useMemo(() => {
        const nextMap = new Map<string, Rect2D[]>();

        visibleRooms.forEach((room) => {
            if (Math.abs(room.rotation || 0) > 0.01) {
                nextMap.set(room.id, []);
                return;
            }
            const openings = (stairOpeningsByFloor.get(room.floorId) || [])
                .map((opening) => getRectIntersection(getRoomBounds(room), opening))
                .filter((opening): opening is Rect2D => opening !== null);
            nextMap.set(room.id, openings);
        });

        return nextMap;
    }, [stairOpeningsByFloor, visibleRooms]);
    const wallDoorMap = useMemo(() => {
        const nextMap = new Map<string, WallOpening[]>();

        visibleDoors.forEach(({ placement }) => {
            if (placement.hostKind !== 'wall') return;
            const openings = nextMap.get(placement.hostId) || [];
            openings.push({
                startDistance: placement.startDistance,
                endDistance: placement.endDistance,
                doorHeight: placement.doorHeight
            });
            nextMap.set(placement.hostId, openings);
        });

        return nextMap;
    }, [visibleDoors]);
    const roomSegmentDoorMap = useMemo(() => {
        const nextMap = new Map<string, WallOpening[]>();

        roomWallSegments.forEach((segment) => {
            nextMap.set(segment.id, []);
        });

        visibleDoors.forEach(({ placement }) => {
            if (placement.hostKind !== 'room' || !placement.edge) return;

            roomWallSegments.forEach((segment) => {
                if (segment.floorId !== placement.floorId) return;

                const matchesContributor = segment.contributors.some(
                    (contributor) => contributor.roomId === placement.hostId
                        && (
                            placement.edgeIndex !== undefined
                                ? contributor.edgeIndex === placement.edgeIndex
                                : contributor.edge === placement.edge
                        )
                );
                if (!matchesContributor) return;

                const segmentStartDistance = projectDistanceOnSegment(placement.start, placement.end, segment.start);
                const segmentEndDistance = projectDistanceOnSegment(placement.start, placement.end, segment.end);
                const overlapStart = Math.max(placement.startDistance, Math.min(segmentStartDistance, segmentEndDistance));
                const overlapEnd = Math.min(placement.endDistance, Math.max(segmentStartDistance, segmentEndDistance));

                if (overlapEnd - overlapStart <= 0.04) return;

                const openings = nextMap.get(segment.id) || [];
                openings.push({
                    startDistance: overlapStart - Math.min(segmentStartDistance, segmentEndDistance),
                    endDistance: overlapEnd - Math.min(segmentStartDistance, segmentEndDistance),
                    doorHeight: placement.doorHeight
                });
                nextMap.set(segment.id, openings);
            });
        });

        return nextMap;
    }, [roomWallSegments, visibleDoors]);
    const renderableDoors = useMemo(
        () => visibleDoors.filter(({ placement }) => {
            if (placement.hostKind !== 'room' || !placement.edge) {
                return true;
            }

            return roomWallSegments.some((segment) => {
                if (!segment.visible || segment.floorId !== placement.floorId) return false;

                const matchesContributor = segment.contributors.some(
                    (contributor) => contributor.roomId === placement.hostId
                        && (
                            placement.edgeIndex !== undefined
                                ? contributor.edgeIndex === placement.edgeIndex
                                : contributor.edge === placement.edge
                        )
                );
                if (!matchesContributor) return false;

                const segmentStartDistance = projectDistanceOnSegment(placement.start, placement.end, segment.start);
                const segmentEndDistance = projectDistanceOnSegment(placement.start, placement.end, segment.end);
                const overlapStart = Math.max(placement.startDistance, Math.min(segmentStartDistance, segmentEndDistance));
                const overlapEnd = Math.min(placement.endDistance, Math.max(segmentStartDistance, segmentEndDistance));

                return overlapEnd - overlapStart > 0.04;
            });
        }),
        [roomWallSegments, visibleDoors]
    );

    const sceneBounds = useMemo(
        () => buildSceneBounds(visibleFloors, visibleRooms, visibleWalls, visibleCylinders, visibleFurniture, visibleSurfaces, visibleStairs, visibleRulers),
        [visibleFloors, visibleRooms, visibleWalls, visibleCylinders, visibleFurniture, visibleSurfaces, visibleStairs, visibleRulers]
    );
    const sceneCenter = useMemo(() => sceneBounds.getCenter(new THREE.Vector3()), [sceneBounds]);
    const sceneSize = useMemo(() => sceneBounds.getSize(new THREE.Vector3()), [sceneBounds]);
    const lowestElevation = visibleFloors.length > 0
        ? Math.min(...visibleFloors.map((floor) => floor.elevation))
        : 0;
    const planeSize = Math.max(sceneSize.x, sceneSize.z, 40) * 2.4;
    const showAllFloors = () => setVisibleFloors(sortedFloors.map((floor) => floor.id));
    const toggleFloorVisibility = (floorId: string) => {
        const nextVisibleIds = visibleFloorIds.includes(floorId)
            ? visibleFloorIds.filter((id) => id !== floorId)
            : [...visibleFloorIds, floorId];
        setVisibleFloors(nextVisibleIds);
    };
    const isolateFloor = (floorId: string) => {
        setActiveFloor(floorId);
        setVisibleFloors([floorId]);
    };

    return (
        <div className="viewer3d-shell">
            <div className="viewer3d-hud">
                <button className="viewer3d-btn" onClick={() => setFitRequestToken((value) => value + 1)}>
                    Fit View (F)
                </button>
                <div className="viewer3d-chip">WASD / Arrows move</div>
            </div>
            <div className="viewer3d-level-strip glass-panel">
                <button className="viewer3d-level-btn" onClick={showAllFloors}>
                    Show all
                </button>
                {sortedFloors.map((floor) => {
                    const isVisible = visibleFloorIds.includes(floor.id);
                    const isActive = floor.id === activeFloorId;

                    return (
                        <div key={floor.id} className={`viewer3d-level-pill ${isActive ? 'active' : ''} ${isVisible ? '' : 'muted'}`}>
                            <button
                                className="viewer3d-level-name"
                                onClick={() => setActiveFloor(floor.id)}
                            >
                                {floor.name}
                            </button>
                            <button
                                className={`viewer3d-level-toggle ${isVisible ? 'on' : 'off'}`}
                                onClick={() => toggleFloorVisibility(floor.id)}
                                title={isVisible ? 'Hide this floor' : 'Show this floor'}
                            >
                                {isVisible ? 'On' : 'Off'}
                            </button>
                            <button
                                className="viewer3d-level-solo"
                                onClick={() => isolateFloor(floor.id)}
                                title="Show only this floor"
                            >
                                Solo
                            </button>
                        </div>
                    );
                })}
            </div>

            <Canvas shadows camera={{ position: [11, 8, 12], fov: 45 }}>
                <color attach="background" args={['#0f1b2d']} />
                <ambientLight intensity={0.95} />
                <hemisphereLight args={['#d7e6ff', '#18263b', 0.8]} />
                <directionalLight
                    position={[18, 24, 14]}
                    intensity={1.45}
                    castShadow
                    shadow-mapSize-width={2048}
                    shadow-mapSize-height={2048}
                    shadow-normalBias={0.03}
                />

                <SceneNavigation controlsRef={controlsRef} bounds={sceneBounds} fitRequestToken={fitRequestToken} />
                <OrbitControls
                    ref={controlsRef}
                    makeDefault
                    enableDamping
                    dampingFactor={0.08}
                    maxPolarAngle={Math.PI / 2.02}
                    minDistance={2}
                    maxDistance={240}
                />
                <Environment preset="city" />

                {visibleRooms.map((room) => {
                    const floor = floorMap.get(room.floorId);
                    return floor ? (
                        <Room3D
                            key={room.id}
                            room={room}
                            floor={floor}
                            openings={roomFloorOpeningsMap.get(room.id) || []}
                        />
                    ) : null;
                })}

                {roomWallSegments.map((segment) => {
                    const floor = floorMap.get(segment.floorId);
                    return floor ? (
                        <RoomWall3D
                            key={segment.id}
                            segment={segment}
                            floor={floor}
                            doorOpenings={roomSegmentDoorMap.get(segment.id) || []}
                            locked={segment.contributors.some((contributor) => contributor.roomId ? lockedRoomIds.has(contributor.roomId) : false)}
                        />
                    ) : null;
                })}

                {visibleWalls.map((wall) => {
                    const floor = floorMap.get(wall.floorId);
                    return floor ? (
                        <Wall3D
                            key={wall.id}
                            wall={wall}
                            floor={floor}
                            doorOpenings={wallDoorMap.get(wall.id) || []}
                        />
                    ) : null;
                })}

                {visibleCylinders.map((cylinder) => {
                    const floor = floorMap.get(cylinder.floorId);
                    return floor ? <Cylinder3D key={cylinder.id} cylinder={cylinder} floor={floor} /> : null;
                })}

                {visibleFurniture.map((item) => {
                    const floor = floorMap.get(item.floorId);
                    return floor ? <Furniture3D key={item.id} item={item} floor={floor} /> : null;
                })}

                {renderableDoors.map((door) => {
                    const floor = floorMap.get(door.placement.floorId);
                    return floor ? (
                        <Door3D
                            key={door.door.id}
                            door={door.door}
                            placement={door.placement}
                            floor={floor}
                        />
                    ) : null;
                })}

                {visibleSurfaces.map((surface) => {
                    const floor = floorMap.get(surface.floorId);
                    const surfaceRooms = visibleRooms.filter((room) => room.floorId === surface.floorId);
                    return floor ? <Surface3D key={surface.id} surface={surface} floor={floor} rooms={surfaceRooms} /> : null;
                })}

                {visibleRulers.map((ruler) => {
                    const floor = floorMap.get(ruler.floorId);
                    return floor ? <Ruler3D key={ruler.id} ruler={ruler} floor={floor} /> : null;
                })}

                {visibleStairs.map((stair) => {
                    const floor = floorMap.get(stair.floorId);
                    const targetFloor = floorMap.get(stair.targetFloorId);
                    return floor && targetFloor ? <Stair3D key={stair.id} stair={stair} floor={floor} targetFloor={targetFloor} /> : null;
                })}

                <ContactShadows
                    resolution={1024}
                    scale={Math.max(sceneSize.x, sceneSize.z, 24) * 2.2}
                    blur={2.8}
                    opacity={0.35}
                    far={Math.max(24, sceneSize.length() * 1.8)}
                    color="#000"
                    position={[sceneCenter.x, lowestElevation - 0.01, sceneCenter.z]}
                />

                <Plane
                    args={[planeSize, planeSize]}
                    rotation={[-Math.PI / 2, 0, 0]}
                    position={[sceneCenter.x, lowestElevation - 0.03, sceneCenter.z]}
                    receiveShadow
                    onClick={() => setSelectedElement(null)}
                >
                    <meshStandardMaterial color="#1d2a40" roughness={0.98} metalness={0.02} />
                </Plane>
            </Canvas>
        </div>
    );
}
