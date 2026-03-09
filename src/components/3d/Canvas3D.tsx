import { useStore, Room, Furniture, Wall, Cylinder, Door, Surface, Floor, Stair } from '../../store/useStore';
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
    getStairOpeningFloorId,
    getWallSegment,
    resolveDoorPlacement,
    subtractRectHolesFromRect,
    subtractWallOverlapsFromRoomSegments,
    type FittedDoorPlacement,
    type Rect2D,
    type RoomWallSegment
} from '../../utils/buildingGeometry';

const DEFAULT_LEVEL_HEIGHT = 3.2;
const WALL_THICKNESS = 0.18;
const FLOOR_THICKNESS = 0.12;
const ROOM_WALL_COLOR = '#eef2f6';
const WORLD_UP = new THREE.Vector3(0, 1, 0);

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
    openings = []
}: {
    start: { x: number; y: number };
    angle: number;
    baseElevation: number;
    length: number;
    height: number;
    thickness: number;
    color: string;
    openings?: WallOpening[];
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
                <Box key={segment.key} args={segment.args} position={segment.position} castShadow receiveShadow>
                    <meshStandardMaterial color={color} />
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
    stairs: Stair[]
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

        let fallbackSize: [number, number, number] = [0.8, 0.5, 0.8];
        if (item.type === 'sofa') fallbackSize = [2, 0.6, 0.9];
        if (item.type === 'bed') fallbackSize = [1.6, 0.4, 2];
        if (item.type === 'plant') fallbackSize = [0.5, 1.2, 0.5];

        const width = item.width ?? fallbackSize[0];
        const height = item.height ?? fallbackSize[1];
        const depth = item.depth ?? fallbackSize[2];
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

    if (!hasGeometry) {
        bounds.set(new THREE.Vector3(-6, 0, -6), new THREE.Vector3(6, 6, 6));
    }

    bounds.expandByScalar(2);
    return bounds;
}

function Room3D({ room, floor, openings = [] }: { room: Room; floor: Floor; openings?: Rect2D[] }) {
    const rotationRadians = -THREE.MathUtils.degToRad(room.rotation || 0);
    const floorPatches = useMemo(
        () => subtractRectHolesFromRect({ x: room.x, y: room.y, width: room.width, height: room.height }, openings),
        [openings, room.height, room.width, room.x, room.y]
    );
    const canUseOpenings = Math.abs(room.rotation || 0) <= 0.01;

    return (
        <>
            {(canUseOpenings ? floorPatches : [{ x: room.x, y: room.y, width: room.width, height: room.height }]).map((patch, index) => (
                <group
                    key={`${room.id}-patch-${index}`}
                    position={[patch.x + patch.width / 2, floor.elevation, patch.y + patch.height / 2]}
                    rotation={[0, canUseOpenings ? 0 : rotationRadians, 0]}
                >
                    <Box args={[patch.width, FLOOR_THICKNESS, patch.height]} position={[0, -FLOOR_THICKNESS / 2, 0]} castShadow receiveShadow>
                        <meshStandardMaterial color={room.color || '#dddddd'} roughness={0.85} />
                    </Box>
                </group>
            ))}
        </>
    );
}

function RoomWall3D({
    segment,
    floor,
    doorOpenings
}: {
    segment: RoomWallSegment;
    floor: Floor;
    doorOpenings: WallOpening[];
}) {
    if (!segment.visible) return null;

    return (
        <WallWithOpenings
            start={segment.start}
            angle={segment.angle}
            baseElevation={floor.elevation}
            length={segment.length}
            height={segment.height}
            thickness={WALL_THICKNESS}
            color={ROOM_WALL_COLOR}
            openings={doorOpenings}
        />
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
    const segment = getWallSegment(wall);
    const height = wall.wallHeight || floor.height || DEFAULT_LEVEL_HEIGHT;

    return (
        <WallWithOpenings
            start={segment.start}
            angle={segment.angle}
            baseElevation={floor.elevation}
            length={segment.length}
            height={height}
            thickness={wall.thickness || WALL_THICKNESS}
            color={wall.color || '#f0f0f0'}
            openings={doorOpenings}
        />
    );
}

function Door3D({ door, placement, floor, thickness }: { door: Door; placement: FittedDoorPlacement; floor: Floor; thickness?: number }) {
    const doorLeafThickness = Math.min(thickness || WALL_THICKNESS, 0.08);

    return (
        <group position={[placement.center.x, floor.elevation, placement.center.y]} rotation={[0, -placement.angle, 0]}>
            <Box args={[placement.width, placement.doorHeight, doorLeafThickness]} position={[0, placement.doorHeight / 2, 0]} castShadow>
                <meshStandardMaterial color={door.color || '#c78d54'} metalness={0.05} roughness={0.45} />
            </Box>
        </group>
    );
}

function Cylinder3D({ cylinder, floor }: { cylinder: Cylinder; floor: Floor }) {
    const height = cylinder.wallHeight || floor.height || DEFAULT_LEVEL_HEIGHT;
    return (
        <group position={[cylinder.x, floor.elevation + height / 2, cylinder.y]}>
            <CylinderShape args={[cylinder.radius, cylinder.radius, height, 32]} castShadow receiveShadow>
                <meshStandardMaterial color={cylinder.color || '#f0f0f0'} />
            </CylinderShape>
        </group>
    );
}

function Furniture3D({ item, floor }: { item: Furniture; floor: Floor }) {
    let color = '#ccc';
    let size: [number, number, number] = [0.8, 0.5, 0.8];

    if (item.type === 'sofa') {
        color = '#ff6b6b';
        size = [2, 0.6, 0.9];
    } else if (item.type === 'bed') {
        color = '#4dabf7';
        size = [1.6, 0.4, 2];
    } else if (item.type === 'plant') {
        color = '#4ade80';
        size = [0.5, 1.2, 0.5];
    }

    const width = item.width ?? size[0];
    const height = item.height ?? size[1];
    const depth = item.depth ?? size[2];
    const altitude = item.altitude || 0;

    return (
        <group position={[item.x + width / 2, floor.elevation + height / 2 + altitude, item.y + depth / 2]}>
            <Box args={[width, height, depth]} castShadow receiveShadow>
                <meshStandardMaterial color={item.color || color} roughness={0.3} />
            </Box>
        </group>
    );
}

function Surface3D({ surface, floor }: { surface: Surface; floor: Floor }) {
    const depth = surface.depth || 0.1;
    const altitude = surface.altitude || 0;

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

        return nextShape;
    }, [surface.points]);

    if (!shape) return null;

    return (
        <group position={[0, floor.elevation + altitude + 0.01, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <mesh receiveShadow castShadow>
                <extrudeGeometry args={[shape, { depth, bevelEnabled: false }]} />
                <meshStandardMaterial color={surface.color || '#cccccc'} side={THREE.DoubleSide} />
            </mesh>
        </group>
    );
}

function Stair3D({ stair, floor, targetFloor }: { stair: Stair; floor: Floor; targetFloor: Floor }) {
    const elevationDelta = targetFloor.elevation - floor.elevation;

    if (Math.abs(elevationDelta) < 0.1) {
        return null;
    }

    const stepCount = Math.max(6, Math.ceil(Math.abs(elevationDelta) / 0.18));
    const treadThickness = 0.08;
    const climbsOnX = stair.direction === 'east' || stair.direction === 'west';
    const runLength = climbsOnX ? stair.width : stair.height;
    const crossLength = climbsOnX ? stair.height : stair.width;
    const treadDepth = Math.max(runLength / stepCount, 0.22);
    const risePerStep = elevationDelta / stepCount;
    const baseX = stair.x + stair.width / 2;
    const baseZ = stair.y + stair.height / 2;

    return (
        <group position={[baseX, floor.elevation, baseZ]}>
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
                    <Box key={index} args={args} position={position} castShadow receiveShadow>
                        <meshStandardMaterial color={stair.color || '#ffd166'} roughness={0.55} />
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
    const { floors, rooms, furniture, walls, cylinders, doors, surfaces, stairs, activeFloorId, setActiveFloor, setVisibleFloors } = useStore();
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
                    (contributor) => contributor.roomId === placement.hostId && contributor.edge === placement.edge
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
                    (contributor) => contributor.roomId === placement.hostId && contributor.edge === placement.edge
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
        () => buildSceneBounds(visibleFloors, visibleRooms, visibleWalls, visibleCylinders, visibleFurniture, visibleSurfaces, visibleStairs),
        [visibleFloors, visibleRooms, visibleWalls, visibleCylinders, visibleFurniture, visibleSurfaces, visibleStairs]
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
                    return floor ? <Surface3D key={surface.id} surface={surface} floor={floor} /> : null;
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
                >
                    <meshStandardMaterial color="#1d2a40" roughness={0.98} metalness={0.02} />
                </Plane>
            </Canvas>
        </div>
    );
}
