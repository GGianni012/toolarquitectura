import { useStore, Room, Wall, Furniture, Door, Cylinder, Surface, Stair, FloorReference } from '../../store/useStore';
import { useDrag } from '@use-gesture/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
    findBestRoomForRect,
    findClosestDoorHost,
    fitDoorToHostSegment,
    fitRectInsideRoom,
    getRectIntersection,
    getRoomBounds,
    getRoomPolygon,
    getStairOpeningFloorId,
    isRoomWallVisible,
    resolveDoorPlacement,
    type DoorHostCandidate,
    type Rect2D
} from '../../utils/buildingGeometry';
import { getFurniturePreset } from '../../utils/furnitureCatalog';
import { getReferenceRotatedSize, normalizeReferenceRotation } from '../../utils/referenceTransforms';
import './Canvas2D.css';

const GRID_SIZE = 50;
const GRID_MAJOR_UNITS = 2;
const FREE_STEP = 0.01;
const SNAP_THRESHOLD = 0.2;
const CANVAS_WORLD_SIZE = 12000;
const DOOR_PLACE_THRESHOLD = 0.45;
const FLOOR_GHOST_MIN_OPACITY = 0.1;
const FLOOR_GHOST_MAX_OPACITY = 0.28;

type Point = { x: number; y: number };
type SnapGuide = { orientation: 'vertical' | 'horizontal'; position: number };
type CandidateMatch = { value: number; delta: number };
type DistanceGuide = {
    orientation: 'horizontal' | 'vertical';
    start: Point;
    end: Point;
    distance: number;
    axis: number;
};

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function roundUnit(value: number) {
    return Math.round(value / FREE_STEP) * FREE_STEP;
}

function toMeters(units: number) {
    const meters = units * 0.5;
    const decimals = meters >= 10 ? 1 : 2;
    return `${meters.toFixed(decimals).replace(/\.?0+$/, '')}m`;
}

function getAdaptiveTextSize(scale: number, basePx: number) {
    return clamp(basePx / Math.max(scale, 0.35), 4, 42);
}

function getGhostFloorOpacity(distance: number) {
    const falloff = 1 / Math.max(distance, 1);
    return clamp(FLOOR_GHOST_MAX_OPACITY * falloff, FLOOR_GHOST_MIN_OPACITY, FLOOR_GHOST_MAX_OPACITY);
}

function integrateRectWithRooms(rect: Rect2D, rooms: Room[], floorId: string) {
    const hostRoom = findBestRoomForRect(rect, rooms, floorId);
    if (!hostRoom) {
        return rect;
    }

    return fitRectInsideRoom(rect, hostRoom);
}

function renderRoomOpenings(openings: Rect2D[], room: Room) {
    return openings.map((opening, index) => (
        <div
            key={`${room.id}-opening-${index}`}
            className="room-opening"
            style={{
                left: (opening.x - room.x) * GRID_SIZE,
                top: (opening.y - room.y) * GRID_SIZE,
                width: opening.width * GRID_SIZE,
                height: opening.height * GRID_SIZE
            }}
        />
    ));
}

function getRectRoomWallStyles(room: Room): CSSProperties {
    return {
        borderTopStyle: isRoomWallVisible(room, 0) ? 'solid' : 'dashed',
        borderTopColor: isRoomWallVisible(room, 0) ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.28)',
        borderRightStyle: isRoomWallVisible(room, 1) ? 'solid' : 'dashed',
        borderRightColor: isRoomWallVisible(room, 1) ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.28)',
        borderBottomStyle: isRoomWallVisible(room, 2) ? 'solid' : 'dashed',
        borderBottomColor: isRoomWallVisible(room, 2) ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.28)',
        borderLeftStyle: isRoomWallVisible(room, 3) ? 'solid' : 'dashed',
        borderLeftColor: isRoomWallVisible(room, 3) ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.28)'
    };
}

function renderPolygonRoomEdges(room: Room, scale: number) {
    const polygon = getRoomPolygon(room);

    return polygon.map((point, index) => {
        const nextPoint = polygon[(index + 1) % polygon.length];
        const isVisible = isRoomWallVisible(room, index);

        return (
            <line
                key={`${room.id}-wall-edge-${index}`}
                x1={point.x * GRID_SIZE}
                y1={point.y * GRID_SIZE}
                x2={nextPoint.x * GRID_SIZE}
                y2={nextPoint.y * GRID_SIZE}
                stroke={isVisible ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.28)'}
                strokeWidth={2 / scale}
                strokeDasharray={isVisible ? undefined : `${10 / scale} ${8 / scale}`}
                style={{ pointerEvents: 'none' }}
            />
        );
    });
}

function getRectCenter(rect: Rect2D) {
    return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2
    };
}

function getObjectBounds(element: Room | Furniture | Cylinder | Stair | Wall, type: 'room' | 'furniture' | 'cylinder' | 'stair' | 'wall'): Rect2D {
    switch (type) {
        case 'room':
            return getRoomBounds(element as Room);
        case 'furniture': {
            const furniture = element as Furniture;
            const preset = getFurniturePreset(furniture.type);
            return {
                x: furniture.x,
                y: furniture.y,
                width: furniture.width ?? preset.width,
                height: furniture.depth ?? preset.depth
            };
        }
        case 'cylinder': {
            const cylinder = element as Cylinder;
            return {
                x: cylinder.x - cylinder.radius,
                y: cylinder.y - cylinder.radius,
                width: cylinder.radius * 2,
                height: cylinder.radius * 2
            };
        }
        case 'stair': {
            const stair = element as Stair;
            return {
                x: stair.x,
                y: stair.y,
                width: stair.width,
                height: stair.height
            };
        }
        case 'wall': {
            const wall = element as Wall;
            const minThickness = 0.12;
            const minX = Math.min(wall.startX, wall.endX);
            const minY = Math.min(wall.startY, wall.endY);
            const width = Math.abs(wall.endX - wall.startX);
            const height = Math.abs(wall.endY - wall.startY);
            return {
                x: width <= minThickness ? minX - minThickness / 2 : minX,
                y: height <= minThickness ? minY - minThickness / 2 : minY,
                width: Math.max(width, minThickness),
                height: Math.max(height, minThickness)
            };
        }
    }
}

function buildDistanceGuides(
    movingRect: Rect2D,
    candidates: Array<{ id: string; rect: Rect2D }>
) {
    const movingCenter = getRectCenter(movingRect);
    const guides: DistanceGuide[] = [];
    const verticalGuides: DistanceGuide[] = [];
    const horizontalGuides: DistanceGuide[] = [];

    candidates.forEach(({ rect }) => {
        const overlapY = Math.min(movingRect.y + movingRect.height, rect.y + rect.height) - Math.max(movingRect.y, rect.y);
        if (overlapY > 0.15) {
            if (rect.x + rect.width <= movingRect.x) {
                verticalGuides.push({
                    orientation: 'horizontal',
                    start: { x: rect.x + rect.width, y: movingCenter.y },
                    end: { x: movingRect.x, y: movingCenter.y },
                    distance: movingRect.x - (rect.x + rect.width),
                    axis: movingCenter.y
                });
            }
            if (rect.x >= movingRect.x + movingRect.width) {
                verticalGuides.push({
                    orientation: 'horizontal',
                    start: { x: movingRect.x + movingRect.width, y: movingCenter.y },
                    end: { x: rect.x, y: movingCenter.y },
                    distance: rect.x - (movingRect.x + movingRect.width),
                    axis: movingCenter.y
                });
            }
        }

        const overlapX = Math.min(movingRect.x + movingRect.width, rect.x + rect.width) - Math.max(movingRect.x, rect.x);
        if (overlapX > 0.15) {
            if (rect.y + rect.height <= movingRect.y) {
                horizontalGuides.push({
                    orientation: 'vertical',
                    start: { x: movingCenter.x, y: rect.y + rect.height },
                    end: { x: movingCenter.x, y: movingRect.y },
                    distance: movingRect.y - (rect.y + rect.height),
                    axis: movingCenter.x
                });
            }
            if (rect.y >= movingRect.y + movingRect.height) {
                horizontalGuides.push({
                    orientation: 'vertical',
                    start: { x: movingCenter.x, y: movingRect.y + movingRect.height },
                    end: { x: movingCenter.x, y: rect.y },
                    distance: rect.y - (movingRect.y + movingRect.height),
                    axis: movingCenter.x
                });
            }
        }
    });

    const nearestHorizontal = verticalGuides
        .filter((guide) => guide.distance > 0.01)
        .sort((a, b) => a.distance - b.distance)[0];
    const nearestVertical = horizontalGuides
        .filter((guide) => guide.distance > 0.01)
        .sort((a, b) => a.distance - b.distance)[0];

    if (nearestHorizontal) guides.push(nearestHorizontal);
    if (nearestVertical) guides.push(nearestVertical);

    return guides;
}

function findNearestCandidate(value: number, candidates: number[]): CandidateMatch | null {
    let nearest: CandidateMatch | null = null;

    candidates.forEach((candidate) => {
        const delta = Math.abs(candidate - value);
        if (delta <= SNAP_THRESHOLD && (!nearest || delta < nearest.delta)) {
            nearest = { value: candidate, delta };
        }
    });

    return nearest;
}

function getRoomEdgeCandidates(rooms: Room[], roomId: string) {
    const otherRooms = rooms.filter((room) => room.id !== roomId);

    return {
        vertical: otherRooms.flatMap((room) => [room.x, room.x + room.width]),
        horizontal: otherRooms.flatMap((room) => [room.y, room.y + room.height])
    };
}

function snapRoomPlacement(rect: { x: number; y: number; width: number; height: number }, rooms: Room[], roomId: string) {
    const candidates = getRoomEdgeCandidates(rooms, roomId);
    const guides: SnapGuide[] = [];
    let nextX = rect.x;
    let nextY = rect.y;

    const leftSnap = findNearestCandidate(rect.x, candidates.vertical);
    const rightSnap = findNearestCandidate(rect.x + rect.width, candidates.vertical);
    let bestVertical: CandidateMatch | null = null;

    if (leftSnap && rightSnap) {
        bestVertical = leftSnap.delta <= rightSnap.delta ? leftSnap : rightSnap;
    } else {
        bestVertical = leftSnap || rightSnap;
    }

    if (bestVertical) {
        const useLeftEdge = !!leftSnap && bestVertical.value === leftSnap.value && bestVertical.delta === leftSnap.delta;
        nextX = useLeftEdge ? bestVertical.value : bestVertical.value - rect.width;
        guides.push({ orientation: 'vertical', position: bestVertical.value });
    }

    const topSnap = findNearestCandidate(rect.y, candidates.horizontal);
    const bottomSnap = findNearestCandidate(rect.y + rect.height, candidates.horizontal);
    let bestHorizontal: CandidateMatch | null = null;

    if (topSnap && bottomSnap) {
        bestHorizontal = topSnap.delta <= bottomSnap.delta ? topSnap : bottomSnap;
    } else {
        bestHorizontal = topSnap || bottomSnap;
    }

    if (bestHorizontal) {
        const useTopEdge = !!topSnap && bestHorizontal.value === topSnap.value && bestHorizontal.delta === topSnap.delta;
        nextY = useTopEdge ? bestHorizontal.value : bestHorizontal.value - rect.height;
        guides.push({ orientation: 'horizontal', position: bestHorizontal.value });
    }

    return { x: nextX, y: nextY, guides };
}

function snapRoomResize(
    rect: { x: number; y: number; width: number; height: number },
    corner: 'tl' | 'tr' | 'bl' | 'br' | 'l' | 'r' | 't' | 'b',
    rooms: Room[],
    roomId: string
) {
    const candidates = getRoomEdgeCandidates(rooms, roomId);
    const guides: SnapGuide[] = [];
    let left = rect.x;
    let right = rect.x + rect.width;
    let top = rect.y;
    let bottom = rect.y + rect.height;

    if (corner.includes('l')) {
        const snap = findNearestCandidate(left, candidates.vertical);
        if (snap && right - snap.value >= 1) {
            left = snap.value;
            guides.push({ orientation: 'vertical', position: snap.value });
        }
    }

    if (corner.includes('r')) {
        const snap = findNearestCandidate(right, candidates.vertical);
        if (snap && snap.value - left >= 1) {
            right = snap.value;
            guides.push({ orientation: 'vertical', position: snap.value });
        }
    }

    if (corner.includes('t')) {
        const snap = findNearestCandidate(top, candidates.horizontal);
        if (snap && bottom - snap.value >= 1) {
            top = snap.value;
            guides.push({ orientation: 'horizontal', position: snap.value });
        }
    }

    if (corner.includes('b')) {
        const snap = findNearestCandidate(bottom, candidates.horizontal);
        if (snap && snap.value - top >= 1) {
            bottom = snap.value;
            guides.push({ orientation: 'horizontal', position: snap.value });
        }
    }

    return {
        x: left,
        y: top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
        guides
    };
}

function getWallPoints(walls: Wall[], ignoreWallId?: string) {
    return walls
        .filter((wall) => wall.id !== ignoreWallId)
        .flatMap((wall) => [
            { x: wall.startX, y: wall.startY },
            { x: wall.endX, y: wall.endY }
        ]);
}

function snapWallPoint(point: Point, walls: Wall[], anchor?: Point, ignoreWallId?: string) {
    const wallPoints = getWallPoints(walls, ignoreWallId);
    const guides: SnapGuide[] = [];
    let nextX = point.x;
    let nextY = point.y;

    if (anchor) {
        if (Math.abs(point.x - anchor.x) <= SNAP_THRESHOLD) {
            nextX = anchor.x;
            guides.push({ orientation: 'vertical', position: anchor.x });
        }

        if (Math.abs(point.y - anchor.y) <= SNAP_THRESHOLD) {
            nextY = anchor.y;
            guides.push({ orientation: 'horizontal', position: anchor.y });
        }
    }

    wallPoints.forEach((candidate) => {
        if (Math.abs(candidate.x - point.x) <= SNAP_THRESHOLD) {
            nextX = candidate.x;
            guides.push({ orientation: 'vertical', position: candidate.x });
        }
        if (Math.abs(candidate.y - point.y) <= SNAP_THRESHOLD) {
            nextY = candidate.y;
            guides.push({ orientation: 'horizontal', position: candidate.y });
        }
        if (Math.abs(candidate.x - point.x) <= SNAP_THRESHOLD && Math.abs(candidate.y - point.y) <= SNAP_THRESHOLD) {
            nextX = candidate.x;
            nextY = candidate.y;
        }
    });

    return { x: nextX, y: nextY, guides };
}

function PointHandle({
    x,
    y,
    scale,
    onDragMove
}: {
    x: number;
    y: number;
    scale: number;
    onDragMove: (mx: number, my: number, first: boolean, memo: any) => any;
}) {
    const bind = useDrag(({ movement: [mx, my], first, memo }) => onDragMove(mx, my, first, memo));
    const bindProps: any = bind();

    return (
        <circle
            {...bindProps}
            onPointerDown={(e) => {
                e.stopPropagation();
                bindProps.onPointerDown?.(e);
            }}
            cx={x}
            cy={y}
            r={6 / scale}
            fill="#4facfe"
            stroke="white"
            strokeWidth={2 / scale}
            style={{ cursor: 'pointer', pointerEvents: 'all' }}
        />
    );
}

function EdgeInsertHandle({
    x,
    y,
    scale,
    onInsert
}: {
    x: number;
    y: number;
    scale: number;
    onInsert: () => void;
}) {
    const radius = 7 / scale;

    return (
        <g
            onPointerDown={(e) => {
                e.stopPropagation();
                onInsert();
            }}
            style={{ cursor: 'copy', pointerEvents: 'all' }}
        >
            <circle
                cx={x}
                cy={y}
                r={radius}
                fill="rgba(79, 172, 254, 0.95)"
                stroke="white"
                strokeWidth={2 / scale}
            />
            <line
                x1={x - radius / 2}
                y1={y}
                x2={x + radius / 2}
                y2={y}
                stroke="white"
                strokeWidth={2 / scale}
                strokeLinecap="round"
            />
            <line
                x1={x}
                y1={y - radius / 2}
                x2={x}
                y2={y + radius / 2}
                stroke="white"
                strokeWidth={2 / scale}
                strokeLinecap="round"
            />
        </g>
    );
}

function ReferenceLayer({
    floorId,
    reference,
    scale
}: {
    floorId: string;
    reference: FloorReference;
    scale: number;
}) {
    const { updateFloor } = useStore();
    const [naturalSize, setNaturalSize] = useState({
        width: reference.width || 0,
        height: reference.height || 0
    });
    useEffect(() => {
        setNaturalSize({
            width: reference.width || 0,
            height: reference.height || 0
        });
    }, [reference.height, reference.id, reference.width]);
    const baseWidth = reference.width || naturalSize.width;
    const baseHeight = reference.height || naturalSize.height;
    const normalizedRotation = normalizeReferenceRotation(reference.rotation || 0);
    const rotatedSize = getReferenceRotatedSize(baseWidth || 1, baseHeight || 1, normalizedRotation);

    const bind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (reference.locked) return memo;
        if (first || !memo) {
            memo = { offsetX: reference.offsetX, offsetY: reference.offsetY };
        }

        updateFloor(floorId, {
            reference: {
                ...reference,
                offsetX: memo.offsetX + mx / scale,
                offsetY: memo.offsetY + my / scale
            }
        });

        return memo;
    }, {
        enabled: !reference.locked
    });

    return (
        <div
            {...bind()}
            className={`reference-layer ${reference.locked ? 'locked' : 'unlocked'}`}
            style={{
                left: reference.offsetX,
                top: reference.offsetY,
                opacity: reference.opacity,
                width: Math.max(1, rotatedSize.width * (reference.scale || 1)),
                height: Math.max(1, rotatedSize.height * (reference.scale || 1)),
                pointerEvents: reference.locked ? 'none' : 'auto'
            }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            <img
                src={reference.src}
                alt={reference.name}
                className="reference-image"
                draggable={false}
                onLoad={(event) => {
                    const image = event.currentTarget;
                    if (naturalSize.width !== image.naturalWidth || naturalSize.height !== image.naturalHeight) {
                        setNaturalSize({
                            width: image.naturalWidth,
                            height: image.naturalHeight
                        });
                    }
                }}
                style={{
                    width: baseWidth || undefined,
                    height: baseHeight || undefined,
                    left: '50%',
                    top: '50%',
                    transform: `translate(-50%, -50%) rotate(${normalizedRotation}deg) scale(${(reference.flipX ? -1 : 1) * (reference.scale || 1)}, ${(reference.flipY ? -1 : 1) * (reference.scale || 1)})`,
                    transformOrigin: 'center center'
                }}
            />
        </div>
    );
}

function WallElement({
    wall,
    scale,
    walls,
    setSnapGuides,
    isDrawing = false
}: {
    wall: Wall | { startX: number; startY: number; currentX: number; currentY: number };
    scale: number;
    walls: Wall[];
    setSnapGuides: (guides: SnapGuide[]) => void;
    isDrawing?: boolean;
}) {
    const { interactMode, updateWall, selectedElement, setSelectedElement } = useStore();
    const isFinished = !isDrawing && 'id' in wall;
    const wallObj = wall as Wall;
    const endX = isFinished ? wallObj.endX : (wall as any).currentX;
    const endY = isFinished ? wallObj.endY : (wall as any).currentY;

    const bind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (interactMode !== 'select' || !isFinished || wallObj.locked) return memo;
        if (first || !memo) {
            memo = { startX: wallObj.startX, startY: wallObj.startY, endX: wallObj.endX, endY: wallObj.endY };
        }

        const dx = roundUnit((mx / scale) / GRID_SIZE);
        const dy = roundUnit((my / scale) / GRID_SIZE);

        updateWall(wallObj.id, {
            startX: roundUnit(memo.startX + dx),
            startY: roundUnit(memo.startY + dy),
            endX: roundUnit(memo.endX + dx),
            endY: roundUnit(memo.endY + dy)
        });
        setSnapGuides([]);

        return memo;
    }, {
        enabled: interactMode === 'select' && isFinished && !wallObj.locked
    });

    const x1 = wall.startX * GRID_SIZE + GRID_SIZE / 2;
    const y1 = wall.startY * GRID_SIZE + GRID_SIZE / 2;
    const x2 = endX * GRID_SIZE + GRID_SIZE / 2;
    const y2 = endY * GRID_SIZE + GRID_SIZE / 2;
    const lengthInUnits = Math.hypot(endX - wall.startX, endY - wall.startY);
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const screenLength = lengthInUnits * GRID_SIZE * scale;
    const showLabel = lengthInUnits > 0 && screenLength > 80;
    const isSelected = isFinished && selectedElement?.id === wallObj.id;
    const bindProps: any = bind();

    return (
        <g
            {...bindProps}
            onPointerDown={(e) => {
                e.stopPropagation();
                if (interactMode === 'select' && isFinished) {
                    setSelectedElement({ id: wallObj.id, type: 'wall' });
                }
                bindProps.onPointerDown?.(e);
            }}
            style={{ pointerEvents: isDrawing || (isFinished && wallObj.locked) ? 'none' : 'auto', cursor: isDrawing ? 'default' : 'grab' }}
        >
            <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={isDrawing ? '#4facfe' : (isSelected ? '#fca5a5' : wallObj.color || 'white')}
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={isDrawing ? '10 5' : 'none'}
                className="wall-2d"
                style={{ pointerEvents: isDrawing ? 'none' : 'stroke' }}
            />
            {showLabel && (
                <text
                    x={midX}
                    y={midY - getAdaptiveTextSize(scale, 12)}
                    fill={isDrawing ? '#4facfe' : 'white'}
                    fontSize={getAdaptiveTextSize(scale, 12)}
                    fontWeight="bold"
                    textAnchor="middle"
                    style={{ textShadow: '0px 2px 4px rgba(0,0,0,0.8)', pointerEvents: 'none' }}
                >
                    {toMeters(lengthInUnits)}
                </text>
            )}
            {isSelected && !wallObj.locked && (
                <>
                    <PointHandle
                        x={x1}
                        y={y1}
                        scale={scale}
                        onDragMove={(mx, my, first, memo) => {
                            if (first || !memo) memo = { x: wallObj.startX, y: wallObj.startY };
                            const rawPoint = {
                                x: roundUnit(memo.x + (mx / scale) / GRID_SIZE),
                                y: roundUnit(memo.y + (my / scale) / GRID_SIZE)
                            };
                            const snapped = snapWallPoint(rawPoint, walls, { x: wallObj.endX, y: wallObj.endY }, wallObj.id);
                            setSnapGuides(snapped.guides);
                            updateWall(wallObj.id, { startX: snapped.x, startY: snapped.y });
                            return memo;
                        }}
                    />
                    <PointHandle
                        x={x2}
                        y={y2}
                        scale={scale}
                        onDragMove={(mx, my, first, memo) => {
                            if (first || !memo) memo = { x: wallObj.endX, y: wallObj.endY };
                            const rawPoint = {
                                x: roundUnit(memo.x + (mx / scale) / GRID_SIZE),
                                y: roundUnit(memo.y + (my / scale) / GRID_SIZE)
                            };
                            const snapped = snapWallPoint(rawPoint, walls, { x: wallObj.startX, y: wallObj.startY }, wallObj.id);
                            setSnapGuides(snapped.guides);
                            updateWall(wallObj.id, { endX: snapped.x, endY: snapped.y });
                            return memo;
                        }}
                    />
                </>
            )}
        </g>
    );
}

function RoomElement({
    room,
    scale,
    rooms,
    setSnapGuides,
    openings = [],
    distanceCandidates,
    setDistanceGuides
}: {
    room: Room;
    scale: number;
    rooms: Room[];
    setSnapGuides: (guides: SnapGuide[]) => void;
    openings?: Rect2D[];
    distanceCandidates: Array<{ id: string; rect: Rect2D }>;
    setDistanceGuides: (guides: DistanceGuide[]) => void;
}) {
    const { updateRoom, interactMode, selectedElement, setSelectedElement } = useStore();
    const isSelected = selectedElement?.id === room.id;

    const bind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (interactMode !== 'select' || room.locked) return memo;
        if (first || !memo) memo = { x: room.x, y: room.y };

        const rawRect = {
            x: roundUnit(memo.x + (mx / scale) / GRID_SIZE),
            y: roundUnit(memo.y + (my / scale) / GRID_SIZE),
            width: room.width,
            height: room.height
        };
        const snapped = snapRoomPlacement(rawRect, rooms, room.id);
        setSnapGuides(snapped.guides);
        setDistanceGuides(
            buildDistanceGuides(
                getRoomBounds({ ...room, x: snapped.x, y: snapped.y }),
                distanceCandidates.filter((candidate) => candidate.id !== room.id)
            )
        );
        updateRoom(room.id, { x: snapped.x, y: snapped.y });

        return memo;
    }, {
        enabled: interactMode === 'select' && !room.locked
    });

    const bindResize = (corner: 'tl' | 'tr' | 'bl' | 'br' | 'l' | 'r' | 't' | 'b') => useDrag(({ movement: [mx, my], event, memo, first }) => {
        if (interactMode !== 'select' || room.locked) return memo;
        event.stopPropagation();

        if (first || !memo) {
            memo = { width: room.width, height: room.height, x: room.x, y: room.y };
        }

        const dmX = roundUnit((mx / scale) / GRID_SIZE);
        const dmY = roundUnit((my / scale) / GRID_SIZE);

        let nextRect = {
            x: memo.x,
            y: memo.y,
            width: memo.width,
            height: memo.height
        };

        if (corner.includes('r')) {
            nextRect.width = Math.max(1, memo.width + dmX);
        }
        if (corner.includes('l')) {
            const shiftX = Math.min(dmX, memo.width - 1);
            nextRect.x = memo.x + shiftX;
            nextRect.width = memo.width - shiftX;
        }
        if (corner.includes('b')) {
            nextRect.height = Math.max(1, memo.height + dmY);
        }
        if (corner.includes('t')) {
            const shiftY = Math.min(dmY, memo.height - 1);
            nextRect.y = memo.y + shiftY;
            nextRect.height = memo.height - shiftY;
        }

        const snapped = snapRoomResize(nextRect, corner, rooms, room.id);
        setSnapGuides(snapped.guides);
        setDistanceGuides(
            buildDistanceGuides(
                getRoomBounds({ ...room, ...snapped }),
                distanceCandidates.filter((candidate) => candidate.id !== room.id)
            )
        );
        updateRoom(room.id, snapped);
        return memo;
    }, {
        enabled: interactMode === 'select' && !room.locked
    });

    const bindTL = bindResize('tl');
    const bindTR = bindResize('tr');
    const bindBL = bindResize('bl');
    const bindBR = bindResize('br');
    const bindL = bindResize('l');
    const bindR = bindResize('r');
    const bindT = bindResize('t');
    const bindB = bindResize('b');
    const screenWidth = room.width * GRID_SIZE * scale;
    const screenHeight = room.height * GRID_SIZE * scale;
    const showName = screenWidth > 70 && screenHeight > 34;
    const showDimensions = screenWidth > 110 && screenHeight > 60;
    const labelFontSize = getAdaptiveTextSize(scale, 14);
    const dimensionsFontSize = getAdaptiveTextSize(scale, 11);

    return (
        <div
            {...bind()}
            onClick={(e) => {
                e.stopPropagation();
                setSelectedElement({ id: room.id, type: 'room' });
            }}
            className={`room-2d ${interactMode !== 'select' ? 'disabled' : ''} ${isSelected ? 'selected' : ''}`}
            style={{
                left: room.x * GRID_SIZE,
                top: room.y * GRID_SIZE,
                width: room.width * GRID_SIZE,
                height: room.height * GRID_SIZE,
                backgroundColor: room.color || '#fff',
                boxShadow: isSelected ? '0 0 0 3px #fca5a5' : undefined,
                transform: `rotate(${room.rotation || 0}deg)`,
                transformOrigin: 'center center',
                ...getRectRoomWallStyles(room)
            }}
        >
            {renderRoomOpenings(openings, room)}
            {showName && (
                <div className="room-label" style={{ fontSize: labelFontSize, padding: `0 ${getAdaptiveTextSize(scale, 8)}px` }}>
                    {room.name}
                </div>
            )}
            {showDimensions && (
                <div className="room-dimensions" style={{ fontSize: dimensionsFontSize }}>
                    {toMeters(room.width)} x {toMeters(room.height)}
                </div>
            )}
            {interactMode === 'select' && !room.locked && isSelected && (
                <>
                    <div {...bindTL()} className="resize-handle tl" title="Resize Top Left" />
                    <div {...bindTR()} className="resize-handle tr" title="Resize Top Right" />
                    <div {...bindBL()} className="resize-handle bl" title="Resize Bottom Left" />
                    <div {...bindBR()} className="resize-handle br" title="Resize Bottom Right" />
                    <div {...bindL()} className="resize-handle l" title="Resize Left" />
                    <div {...bindR()} className="resize-handle r" title="Resize Right" />
                    <div {...bindT()} className="resize-handle t" title="Resize Top" />
                    <div {...bindB()} className="resize-handle b" title="Resize Bottom" />
                </>
            )}
        </div>
    );
}

function FurnitureElement({
    item,
    scale,
    distanceCandidates,
    setDistanceGuides
}: {
    item: Furniture;
    scale: number;
    distanceCandidates: Array<{ id: string; rect: Rect2D }>;
    setDistanceGuides: (guides: DistanceGuide[]) => void;
}) {
    const { updateFurniture, interactMode, selectedElement, setSelectedElement } = useStore();
    const isSelected = selectedElement?.id === item.id;
    const preset = getFurniturePreset(item.type);
    const width = item.width ?? preset.width;
    const depth = item.depth ?? preset.depth;

    const bind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (interactMode !== 'select' || item.locked) return memo;
        if (first || !memo) memo = { x: item.x, y: item.y };

        const nextRect = {
            x: roundUnit(memo.x + (mx / scale) / GRID_SIZE),
            y: roundUnit(memo.y + (my / scale) / GRID_SIZE),
            width,
            height: depth
        };
        setDistanceGuides(buildDistanceGuides(nextRect, distanceCandidates.filter((candidate) => candidate.id !== item.id)));
        updateFurniture(item.id, {
            x: nextRect.x,
            y: nextRect.y
        });

        return memo;
    }, {
        enabled: interactMode === 'select' && !item.locked
    });
    const bindResize = (axis: 'width' | 'depth') => useDrag(({ movement: [mx, my], first, memo, event }) => {
        if (interactMode !== 'select' || item.locked) return memo;
        event.stopPropagation();
        if (first || !memo) memo = { width, depth };

        if (axis === 'width') {
            updateFurniture(item.id, {
                width: Math.max(0.2, roundUnit(memo.width + (mx / scale) / GRID_SIZE))
            });
        } else {
            updateFurniture(item.id, {
                depth: Math.max(0.2, roundUnit(memo.depth + (my / scale) / GRID_SIZE))
            });
        }

        return memo;
    }, { enabled: interactMode === 'select' && !item.locked });
    const bindWidth = bindResize('width');
    const bindDepth = bindResize('depth');

    const renderTopView = () => {
        switch (item.type) {
            case 'sofa':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="18" y="34" width="64" height="34" rx="14" fill="#f7d7d1" stroke="#ffe9e5" strokeWidth="4" />
                        <rect x="26" y="24" width="48" height="18" rx="9" fill="#ffd5c6" />
                        <rect x="14" y="42" width="14" height="22" rx="7" fill="#ffb49f" />
                        <rect x="72" y="42" width="14" height="22" rx="7" fill="#ffb49f" />
                    </svg>
                );
            case 'bed':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="18" y="16" width="64" height="68" rx="10" fill="#d2ecff" stroke="#eef8ff" strokeWidth="4" />
                        <rect x="18" y="16" width="64" height="18" rx="10" fill="#9fc9ea" />
                        <rect x="26" y="38" width="20" height="14" rx="6" fill="#fdfdfd" />
                        <rect x="54" y="38" width="20" height="14" rx="6" fill="#fdfdfd" />
                    </svg>
                );
            case 'plant':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <circle cx="50" cy="42" r="22" fill="#74d68e" />
                        <circle cx="36" cy="50" r="14" fill="#4fb86b" />
                        <circle cx="64" cy="50" r="14" fill="#4fb86b" />
                        <rect x="38" y="62" width="24" height="18" rx="6" fill="#8a6042" />
                    </svg>
                );
            case 'dining_table':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="20" y="28" width="60" height="44" rx="12" fill="#d8b189" stroke="#f3dcc7" strokeWidth="4" />
                        <circle cx="32" cy="40" r="4" fill="#9b7250" />
                        <circle cx="68" cy="40" r="4" fill="#9b7250" />
                        <circle cx="32" cy="60" r="4" fill="#9b7250" />
                        <circle cx="68" cy="60" r="4" fill="#9b7250" />
                    </svg>
                );
            case 'round_table':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <circle cx="50" cy="50" r="26" fill="#d6ba9c" stroke="#f6e6d5" strokeWidth="4" />
                        <circle cx="50" cy="50" r="6" fill="#9c7858" />
                        <circle cx="50" cy="18" r="8" fill="#8d97ad" />
                        <circle cx="82" cy="50" r="8" fill="#8d97ad" />
                        <circle cx="50" cy="82" r="8" fill="#8d97ad" />
                        <circle cx="18" cy="50" r="8" fill="#8d97ad" />
                    </svg>
                );
            case 'dining_chair':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="28" y="22" width="44" height="18" rx="8" fill="#cfd7e6" />
                        <rect x="30" y="42" width="40" height="28" rx="10" fill="#7f8ba4" />
                        <line x1="34" y1="70" x2="28" y2="84" stroke="#d0d8e6" strokeWidth="5" />
                        <line x1="66" y1="70" x2="72" y2="84" stroke="#d0d8e6" strokeWidth="5" />
                        <line x1="40" y1="70" x2="40" y2="86" stroke="#d0d8e6" strokeWidth="5" />
                        <line x1="60" y1="70" x2="60" y2="86" stroke="#d0d8e6" strokeWidth="5" />
                    </svg>
                );
            case 'bar_stool':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <circle cx="50" cy="28" r="18" fill="#d9b491" />
                        <rect x="46" y="42" width="8" height="24" rx="4" fill="#e8eef7" />
                        <circle cx="50" cy="74" r="18" fill="none" stroke="#d8e2ef" strokeWidth="5" />
                        <circle cx="50" cy="74" r="4" fill="#d8e2ef" />
                    </svg>
                );
            case 'booth_seat':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="14" y="22" width="72" height="20" rx="10" fill="#d77e7e" />
                        <rect x="14" y="44" width="72" height="30" rx="10" fill="#b95e5e" />
                        <rect x="18" y="76" width="64" height="8" rx="4" fill="#f1d1c2" />
                    </svg>
                );
            case 'corner_booth':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <path d="M14 18 H62 A10 10 0 0 1 72 28 V38 H42 V70 H30 A16 16 0 0 1 14 54 Z" fill="#bb666d" stroke="#f1ccd0" strokeWidth="4" />
                        <path d="M42 38 H72 A14 14 0 0 1 86 52 V86 H58 V54 H42 Z" fill="#93484d" />
                        <rect x="20" y="76" width="62" height="8" rx="4" fill="#f2d8c8" />
                    </svg>
                );
            case 'service_counter':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="10" y="24" width="80" height="14" rx="7" fill="#d8dde9" />
                        <rect x="14" y="38" width="72" height="42" rx="8" fill="#71798d" />
                        <line x1="38" y1="40" x2="38" y2="78" stroke="#9ca5b7" strokeWidth="4" />
                        <line x1="62" y1="40" x2="62" y2="78" stroke="#9ca5b7" strokeWidth="4" />
                    </svg>
                );
            case 'host_stand':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <path d="M26 26 H74 L66 78 H34 Z" fill="#7b6555" stroke="#dac4b6" strokeWidth="4" />
                        <rect x="22" y="18" width="56" height="12" rx="6" fill="#cfaf90" />
                        <rect x="40" y="40" width="20" height="8" rx="4" fill="#ead7c8" opacity="0.85" />
                    </svg>
                );
            case 'prep_table':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="14" y="24" width="72" height="14" rx="6" fill="#dce6ee" />
                        <rect x="20" y="52" width="60" height="8" rx="4" fill="#a7b6c0" />
                        <line x1="24" y1="38" x2="20" y2="84" stroke="#dce6ee" strokeWidth="5" />
                        <line x1="76" y1="38" x2="80" y2="84" stroke="#dce6ee" strokeWidth="5" />
                        <line x1="40" y1="38" x2="40" y2="84" stroke="#dce6ee" strokeWidth="5" />
                        <line x1="60" y1="38" x2="60" y2="84" stroke="#dce6ee" strokeWidth="5" />
                    </svg>
                );
            case 'stove_range':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="18" y="20" width="64" height="60" rx="10" fill="#707a84" />
                        <circle cx="34" cy="40" r="9" fill="#2b3440" stroke="#dce6ef" strokeWidth="3" />
                        <circle cx="66" cy="40" r="9" fill="#2b3440" stroke="#dce6ef" strokeWidth="3" />
                        <circle cx="34" cy="62" r="9" fill="#2b3440" stroke="#dce6ef" strokeWidth="3" />
                        <circle cx="66" cy="62" r="9" fill="#2b3440" stroke="#dce6ef" strokeWidth="3" />
                        <rect x="26" y="14" width="48" height="8" rx="4" fill="#dce6ef" />
                    </svg>
                );
            case 'fryer_station':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="18" y="20" width="64" height="60" rx="10" fill="#79838d" />
                        <rect x="24" y="28" width="22" height="22" rx="5" fill="#55606a" />
                        <rect x="54" y="28" width="22" height="22" rx="5" fill="#55606a" />
                        <path d="M30 18 V8 M40 18 V8 M60 18 V8 M70 18 V8" stroke="#dfe7ee" strokeWidth="4" strokeLinecap="round" />
                        <rect x="28" y="56" width="44" height="8" rx="4" fill="#d4dee8" />
                    </svg>
                );
            case 'oven_unit':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="18" y="14" width="64" height="72" rx="10" fill="#6b7481" />
                        <rect x="26" y="32" width="48" height="34" rx="8" fill="#2d343e" stroke="#c7d2de" strokeWidth="4" />
                        <circle cx="34" cy="22" r="3.5" fill="#dbe4ec" />
                        <circle cx="46" cy="22" r="3.5" fill="#dbe4ec" />
                        <circle cx="58" cy="22" r="3.5" fill="#dbe4ec" />
                        <circle cx="70" cy="22" r="3.5" fill="#dbe4ec" />
                        <rect x="30" y="72" width="40" height="6" rx="3" fill="#dbe4ec" />
                    </svg>
                );
            case 'double_sink':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="14" y="24" width="72" height="46" rx="8" fill="#b9cad5" />
                        <rect x="22" y="32" width="24" height="24" rx="6" fill="#6d7c86" />
                        <rect x="54" y="32" width="24" height="24" rx="6" fill="#6d7c86" />
                        <path d="M50 18 C50 12, 62 12, 62 20" stroke="#dce6ef" strokeWidth="5" fill="none" />
                    </svg>
                );
            case 'fridge_display':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="24" y="10" width="52" height="80" rx="10" fill="#e9f2f7" stroke="#b8cedc" strokeWidth="4" />
                        <line x1="50" y1="14" x2="50" y2="86" stroke="#8ca7b6" strokeWidth="4" />
                        <line x1="38" y1="30" x2="38" y2="56" stroke="#8ca7b6" strokeWidth="4" />
                        <line x1="62" y1="44" x2="62" y2="70" stroke="#8ca7b6" strokeWidth="4" />
                    </svg>
                );
            case 'display_case':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <path d="M18 34 L82 24 L76 58 L24 66 Z" fill="#9fd1db" stroke="#d7f1f6" strokeWidth="4" />
                        <rect x="20" y="58" width="60" height="18" rx="6" fill="#55606f" />
                        <line x1="50" y1="24" x2="50" y2="76" stroke="#d7f1f6" strokeWidth="3" opacity="0.75" />
                    </svg>
                );
            case 'espresso_station':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="18" y="26" width="64" height="38" rx="10" fill="#5a6271" />
                        <rect x="28" y="36" width="16" height="12" rx="4" fill="#d9e4ef" />
                        <rect x="56" y="36" width="16" height="12" rx="4" fill="#d9e4ef" />
                        <line x1="36" y1="48" x2="36" y2="66" stroke="#c8d5e1" strokeWidth="4" />
                        <line x1="64" y1="48" x2="64" y2="66" stroke="#c8d5e1" strokeWidth="4" />
                        <rect x="24" y="68" width="52" height="10" rx="5" fill="#c29a6a" />
                    </svg>
                );
            case 'bakery_rack':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <line x1="26" y1="12" x2="20" y2="88" stroke="#dfe8ef" strokeWidth="5" />
                        <line x1="74" y1="12" x2="80" y2="88" stroke="#dfe8ef" strokeWidth="5" />
                        <rect x="24" y="22" width="52" height="7" rx="3.5" fill="#b3bfca" />
                        <rect x="22" y="40" width="56" height="7" rx="3.5" fill="#b3bfca" />
                        <rect x="20" y="58" width="60" height="7" rx="3.5" fill="#b3bfca" />
                        <rect x="18" y="76" width="64" height="7" rx="3.5" fill="#b3bfca" />
                    </svg>
                );
            case 'salad_bar':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="14" y="48" width="72" height="24" rx="8" fill="#83ad9e" />
                        <path d="M20 44 H80 L70 24 H30 Z" fill="#b7e0d1" stroke="#ebfff8" strokeWidth="4" />
                        <line x1="36" y1="30" x2="30" y2="72" stroke="#ebfff8" strokeWidth="3" />
                        <line x1="64" y1="30" x2="70" y2="72" stroke="#ebfff8" strokeWidth="3" />
                        <rect x="24" y="52" width="14" height="12" rx="4" fill="#d7ece1" />
                        <rect x="43" y="52" width="14" height="12" rx="4" fill="#d7ece1" />
                        <rect x="62" y="52" width="14" height="12" rx="4" fill="#d7ece1" />
                    </svg>
                );
            case 'beer_tap':
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="14" y="50" width="72" height="24" rx="8" fill="#8a6f57" />
                        <rect x="24" y="24" width="52" height="18" rx="9" fill="#d7b48f" />
                        <line x1="36" y1="24" x2="36" y2="56" stroke="#e7eef5" strokeWidth="4" />
                        <line x1="50" y1="24" x2="50" y2="56" stroke="#e7eef5" strokeWidth="4" />
                        <line x1="64" y1="24" x2="64" y2="56" stroke="#e7eef5" strokeWidth="4" />
                        <circle cx="36" cy="58" r="4" fill="#f0d36a" />
                        <circle cx="50" cy="58" r="4" fill="#f0d36a" />
                        <circle cx="64" cy="58" r="4" fill="#f0d36a" />
                    </svg>
                );
            default:
                return (
                    <svg viewBox="0 0 100 100" className="furniture-svg">
                        <rect x="18" y="18" width="64" height="64" rx="14" fill="#d9dee8" />
                    </svg>
                );
        }
    };

    return (
        <div
            {...bind()}
            onClick={(e) => {
                e.stopPropagation();
                setSelectedElement({ id: item.id, type: 'furniture' });
            }}
            className={`furniture-2d ${interactMode !== 'select' ? 'disabled' : ''} ${isSelected ? 'selected' : ''}`}
            style={{
                left: item.x * GRID_SIZE,
                top: item.y * GRID_SIZE,
                width: width * GRID_SIZE,
                height: depth * GRID_SIZE,
                transform: `rotate(${item.rotation}deg)`,
                transformOrigin: 'center center',
                backgroundColor: item.color || preset.color,
                boxShadow: isSelected ? '0 0 0 3px #fca5a5' : undefined
            }}
        >
            {renderTopView()}
            {interactMode === 'select' && !item.locked && isSelected && (
                <>
                    <div {...bindWidth()} className="resize-handle r" title="Resize width" />
                    <div {...bindDepth()} className="resize-handle b" title="Resize depth" />
                </>
            )}
        </div>
    );
}

function CylinderElement({
    cylinder,
    scale,
    distanceCandidates,
    setDistanceGuides
}: {
    cylinder: Cylinder;
    scale: number;
    distanceCandidates: Array<{ id: string; rect: Rect2D }>;
    setDistanceGuides: (guides: DistanceGuide[]) => void;
}) {
    const { updateCylinder, interactMode, selectedElement, setSelectedElement } = useStore();
    const isSelected = selectedElement?.id === cylinder.id;

    const bind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (interactMode !== 'select' || cylinder.locked) return memo;
        if (first || !memo) memo = { x: cylinder.x, y: cylinder.y };

        const nextCenter = {
            x: roundUnit(memo.x + (mx / scale) / GRID_SIZE),
            y: roundUnit(memo.y + (my / scale) / GRID_SIZE)
        };
        const nextRect = {
            x: nextCenter.x - cylinder.radius,
            y: nextCenter.y - cylinder.radius,
            width: cylinder.radius * 2,
            height: cylinder.radius * 2
        };
        setDistanceGuides(buildDistanceGuides(nextRect, distanceCandidates.filter((candidate) => candidate.id !== cylinder.id)));
        updateCylinder(cylinder.id, {
            x: nextCenter.x,
            y: nextCenter.y
        });

        return memo;
    }, { enabled: interactMode === 'select' && !cylinder.locked });
    const bindRadius = (direction: 'east' | 'west' | 'north' | 'south') => useDrag(({ movement: [mx, my], first, memo, event }) => {
        if (interactMode !== 'select' || cylinder.locked) return memo;
        event.stopPropagation();
        if (first || !memo) memo = { radius: cylinder.radius };

        const deltaX = roundUnit((mx / scale) / GRID_SIZE);
        const deltaY = roundUnit((my / scale) / GRID_SIZE);
        const directionalDelta = direction === 'east'
            ? deltaX
            : direction === 'west'
                ? -deltaX
                : direction === 'south'
                    ? deltaY
                    : -deltaY;

        updateCylinder(cylinder.id, {
            radius: Math.max(0.25, roundUnit(memo.radius + directionalDelta))
        });

        return memo;
    }, { enabled: interactMode === 'select' && !cylinder.locked });
    const showLabel = cylinder.radius * 2 * GRID_SIZE * scale > 70;
    const bindEast = bindRadius('east');
    const bindWest = bindRadius('west');
    const bindNorth = bindRadius('north');
    const bindSouth = bindRadius('south');

    return (
        <div
            {...bind()}
            onClick={(e) => {
                e.stopPropagation();
                setSelectedElement({ id: cylinder.id, type: 'cylinder' });
            }}
            className={`room-2d ${interactMode !== 'select' ? 'disabled' : ''} ${isSelected ? 'selected' : ''}`}
            style={{
                left: (cylinder.x - cylinder.radius) * GRID_SIZE,
                top: (cylinder.y - cylinder.radius) * GRID_SIZE,
                width: cylinder.radius * 2 * GRID_SIZE,
                height: cylinder.radius * 2 * GRID_SIZE,
                borderRadius: '50%',
                backgroundColor: cylinder.color || '#b8ffb8',
                boxShadow: isSelected ? '0 0 0 3px #fca5a5' : undefined
            }}
        >
            {showLabel && (
                <div className="room-label" style={{ fontSize: getAdaptiveTextSize(scale, 13), padding: `0 ${getAdaptiveTextSize(scale, 8)}px` }}>
                    {cylinder.name}
                </div>
            )}
            {interactMode === 'select' && !cylinder.locked && isSelected && (
                <>
                    <div {...bindEast()} className="resize-handle r" title="Expand radius east" />
                    <div {...bindWest()} className="resize-handle l" title="Expand radius west" />
                    <div {...bindNorth()} className="resize-handle t" title="Expand radius north" />
                    <div {...bindSouth()} className="resize-handle b" title="Expand radius south" />
                </>
            )}
        </div>
    );
}

function DoorElement({ door, scale }: { door: Door; scale: number }) {
    const { rooms, walls, updateDoor, interactMode, selectedElement, setSelectedElement } = useStore();
    const placement = resolveDoorPlacement(door, rooms, walls);
    if (!placement) return null;

    const bind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (interactMode !== 'select' || door.locked) return memo;
        if (first || !memo) {
            memo = { centerDistance: placement.centerDistance };
        }

        const dx = (mx / scale) / GRID_SIZE;
        const dy = (my / scale) / GRID_SIZE;
        const directionX = (placement.end.x - placement.start.x) / placement.length;
        const directionY = (placement.end.y - placement.start.y) / placement.length;
        const deltaAlongSegment = dx * directionX + dy * directionY;
        const nextRatio = (memo.centerDistance + deltaAlongSegment) / placement.length;

        updateDoor(door.id, { ratio: Math.min(Math.max(nextRatio, 0), 1) });
        return memo;
    }, {
        enabled: interactMode === 'select' && !door.locked
    });

    const bindProps: any = bind();
    const isSelected = selectedElement?.id === door.id;
    const angle = placement.angle * (180 / Math.PI);

    return (
        <div
            {...bindProps}
            onPointerDown={(e) => {
                e.stopPropagation();
                if (interactMode === 'select') {
                    setSelectedElement({ id: door.id, type: 'door' });
                }
                bindProps.onPointerDown?.(e);
            }}
            style={{
                position: 'absolute',
                left: placement.center.x * GRID_SIZE,
                top: placement.center.y * GRID_SIZE,
                width: placement.width * GRID_SIZE,
                height: 12,
                backgroundColor: door.color || (isSelected ? '#fca5a5' : '#fbbf24'),
                transform: `translate(-50%, -50%) rotate(${angle}deg)`,
                cursor: interactMode === 'select' && !door.locked ? 'grab' : 'pointer',
                zIndex: 3,
                boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
                borderRadius: 999,
                border: isSelected ? '2px solid white' : 'none'
            }}
        />
    );
}

function StairElement({
    stair,
    scale,
    distanceCandidates,
    setDistanceGuides
}: {
    stair: Stair;
    scale: number;
    distanceCandidates: Array<{ id: string; rect: Rect2D }>;
    setDistanceGuides: (guides: DistanceGuide[]) => void;
}) {
    const { floors, rooms, updateStair, interactMode, selectedElement, setSelectedElement } = useStore();
    const isSelected = selectedElement?.id === stair.id;
    const targetFloor = floors.find((floor) => floor.id === stair.targetFloorId);

    const bind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (interactMode !== 'select' || stair.locked) return memo;
        if (first || !memo) memo = { x: stair.x, y: stair.y };

        const nextRect = integrateRectWithRooms({
            x: roundUnit(memo.x + (mx / scale) / GRID_SIZE),
            y: roundUnit(memo.y + (my / scale) / GRID_SIZE),
            width: stair.width,
            height: stair.height
        }, rooms, stair.floorId);
        setDistanceGuides(buildDistanceGuides(nextRect, distanceCandidates.filter((candidate) => candidate.id !== stair.id)));

        updateStair(stair.id, {
            x: nextRect.x,
            y: nextRect.y
        });

        return memo;
    }, { enabled: interactMode === 'select' && !stair.locked });
    const bindResize = (axis: 'width' | 'height') => useDrag(({ movement: [mx, my], first, memo, event }) => {
        if (interactMode !== 'select' || stair.locked) return memo;
        event.stopPropagation();
        if (first || !memo) memo = { width: stair.width, height: stair.height };

        if (axis === 'width') {
            updateStair(stair.id, {
                width: Math.max(1, roundUnit(memo.width + (mx / scale) / GRID_SIZE))
            });
        } else {
            updateStair(stair.id, {
                height: Math.max(2, roundUnit(memo.height + (my / scale) / GRID_SIZE))
            });
        }

        return memo;
    }, { enabled: interactMode === 'select' && !stair.locked });
    const bindWidth = bindResize('width');
    const bindHeight = bindResize('height');
    const screenWidth = stair.width * GRID_SIZE * scale;
    const screenHeight = stair.height * GRID_SIZE * scale;
    const showArrow = screenWidth > 60 && screenHeight > 40;
    const showLabel = screenWidth > 95 && screenHeight > 70;

    return (
        <div
            {...bind()}
            onClick={(e) => {
                e.stopPropagation();
                setSelectedElement({ id: stair.id, type: 'stair' });
            }}
            className={`stair-2d ${interactMode !== 'select' ? 'disabled' : ''} ${isSelected ? 'selected' : ''}`}
            style={{
                left: stair.x * GRID_SIZE,
                top: stair.y * GRID_SIZE,
                width: stair.width * GRID_SIZE,
                height: stair.height * GRID_SIZE,
                backgroundColor: stair.color || '#ffd166',
                boxShadow: isSelected ? '0 0 0 3px #fca5a5' : undefined
            }}
        >
            {showArrow && (
                <div className="stair-arrow" style={{ fontSize: getAdaptiveTextSize(scale, 11) }}>
                    {stair.direction.toUpperCase()}
                </div>
            )}
            {showLabel && (
                <div className="stair-label" style={{ fontSize: getAdaptiveTextSize(scale, 12) }}>
                    {targetFloor ? targetFloor.name : 'Target floor'}
                </div>
            )}
            {interactMode === 'select' && !stair.locked && isSelected && (
                <>
                    <div {...bindWidth()} className="resize-handle r" title="Resize width" />
                    <div {...bindHeight()} className="resize-handle b" title="Resize run" />
                </>
            )}
        </div>
    );
}

function SurfaceElement({ surface, scale }: { surface: Surface; scale: number }) {
    const { interactMode, selectedElement, setSelectedElement, updateSurface } = useStore();
    const isSelected = selectedElement?.id === surface.id;

    const bind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (interactMode !== 'select' || surface.locked) return memo;
        if (first || !memo) memo = { points: surface.points.map((point) => ({ ...point })) };

        const dx = roundUnit((mx / scale) / GRID_SIZE);
        const dy = roundUnit((my / scale) / GRID_SIZE);

        updateSurface(surface.id, {
            points: memo.points.map((point: Point) => ({ x: point.x + dx, y: point.y + dy }))
        });

        return memo;
    }, { enabled: interactMode === 'select' && !surface.locked });

    if (surface.points.length === 0) return null;
    const pointsStr = surface.points.map((point) => `${point.x * GRID_SIZE},${point.y * GRID_SIZE}`).join(' ');
    const bindProps: any = bind();

    return (
        <g>
            <polygon
                {...bindProps}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    if (interactMode === 'select') {
                        setSelectedElement({ id: surface.id, type: 'surface' });
                    }
                    bindProps.onPointerDown?.(e);
                }}
                points={pointsStr}
                fill={surface.color || 'rgba(200, 200, 200, 0.5)'}
                stroke={isSelected ? '#fca5a5' : '#666'}
                strokeWidth={isSelected ? 3 / scale : 1 / scale}
                style={{ cursor: interactMode === 'select' ? (surface.locked ? 'pointer' : 'grab') : 'default', pointerEvents: interactMode === 'select' ? 'all' : 'none' }}
            />
            {isSelected && surface.points.map((point, index) => {
                const nextPoint = surface.points[(index + 1) % surface.points.length];
                const insertPoint = {
                    x: roundUnit((point.x + nextPoint.x) / 2),
                    y: roundUnit((point.y + nextPoint.y) / 2)
                };

                return (
                    <g key={`surface-edge-${index}`}>
                        <line
                            x1={point.x * GRID_SIZE}
                            y1={point.y * GRID_SIZE}
                            x2={nextPoint.x * GRID_SIZE}
                            y2={nextPoint.y * GRID_SIZE}
                            stroke="rgba(255,255,255,0.75)"
                            strokeWidth={1.5 / scale}
                            strokeDasharray={`${8 / scale} ${6 / scale}`}
                            style={{ pointerEvents: 'none' }}
                        />
                        {!surface.locked && (
                            <EdgeInsertHandle
                                x={insertPoint.x * GRID_SIZE}
                                y={insertPoint.y * GRID_SIZE}
                                scale={scale}
                                onInsert={() => {
                                    const nextPoints = [...surface.points];
                                    nextPoints.splice(index + 1, 0, insertPoint);
                                    updateSurface(surface.id, { points: nextPoints });
                                }}
                            />
                        )}
                    </g>
                );
            })}
            {isSelected && !surface.locked && surface.points.map((point, index) => (
                <PointHandle
                    key={index}
                    x={point.x * GRID_SIZE}
                    y={point.y * GRID_SIZE}
                    scale={scale}
                    onDragMove={(mx, my, first, memo) => {
                        if (first || !memo) memo = { x: point.x, y: point.y };
                        const newPoint = {
                            x: roundUnit(memo.x + (mx / scale) / GRID_SIZE),
                            y: roundUnit(memo.y + (my / scale) / GRID_SIZE)
                        };
                        const newPoints = [...surface.points];
                        newPoints[index] = newPoint;
                        updateSurface(surface.id, { points: newPoints });
                        return memo;
                    }}
                />
            ))}
        </g>
    );
}

function PolygonRoomElement({
    room,
    scale,
    distanceCandidates,
    setDistanceGuides
}: {
    room: Room;
    scale: number;
    distanceCandidates: Array<{ id: string; rect: Rect2D }>;
    setDistanceGuides: (guides: DistanceGuide[]) => void;
}) {
    const { interactMode, selectedElement, setSelectedElement, updateRoom } = useStore();
    const isSelected = selectedElement?.id === room.id;
    const roomPoints = room.points || [];
    const bind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (interactMode !== 'select' || room.locked || roomPoints.length < 3) return memo;
        if (first || !memo) memo = { points: roomPoints.map((point) => ({ ...point })) };

        const dx = roundUnit((mx / scale) / GRID_SIZE);
        const dy = roundUnit((my / scale) / GRID_SIZE);
        const nextPoints = memo.points.map((point: Point) => ({ x: point.x + dx, y: point.y + dy }));
        const nextRoom = { ...room, points: nextPoints };
        const nextBounds = getRoomBounds(nextRoom);

        setDistanceGuides(
            buildDistanceGuides(
                nextBounds,
                distanceCandidates.filter((candidate) => candidate.id !== room.id)
            )
        );
        updateRoom(room.id, { points: nextPoints, ...nextBounds });

        return memo;
    }, { enabled: interactMode === 'select' && !room.locked });

    if (roomPoints.length < 3) return null;

    const pointsStr = roomPoints.map((point) => `${point.x * GRID_SIZE},${point.y * GRID_SIZE}`).join(' ');
    const bounds = getRoomBounds(room);
    const centerX = (bounds.x + bounds.width / 2) * GRID_SIZE;
    const centerY = (bounds.y + bounds.height / 2) * GRID_SIZE;
    const bindProps: any = bind();

    return (
        <g>
            <polygon
                {...bindProps}
                onPointerDown={(e) => {
                    e.stopPropagation();
                    if (interactMode === 'select') {
                        setSelectedElement({ id: room.id, type: 'room' });
                    }
                    bindProps.onPointerDown?.(e);
                }}
                points={pointsStr}
                fill={room.color || 'rgba(255, 184, 184, 0.58)'}
                stroke={isSelected ? '#fca5a5' : 'rgba(255,255,255,0.12)'}
                strokeWidth={isSelected ? 2 / scale : 1 / scale}
                style={{ cursor: interactMode === 'select' ? (room.locked ? 'pointer' : 'grab') : 'default', pointerEvents: interactMode === 'select' ? 'all' : 'none' }}
            />
            {renderPolygonRoomEdges(room, scale)}
            <text
                x={centerX}
                y={centerY}
                fill="rgba(255,255,255,0.92)"
                fontSize={getAdaptiveTextSize(scale, 13)}
                fontWeight="700"
                textAnchor="middle"
                style={{ pointerEvents: 'none', textShadow: '0px 2px 4px rgba(0,0,0,0.8)' }}
            >
                {room.name}
            </text>
            {isSelected && roomPoints.map((point, index) => {
                const nextPoint = roomPoints[(index + 1) % roomPoints.length];
                const insertPoint = {
                    x: roundUnit((point.x + nextPoint.x) / 2),
                    y: roundUnit((point.y + nextPoint.y) / 2)
                };

                return (
                    <g key={`${room.id}-edge-${index}`}>
                        <line
                            x1={point.x * GRID_SIZE}
                            y1={point.y * GRID_SIZE}
                            x2={nextPoint.x * GRID_SIZE}
                            y2={nextPoint.y * GRID_SIZE}
                            stroke="rgba(255,255,255,0.75)"
                            strokeWidth={1.5 / scale}
                            strokeDasharray={`${8 / scale} ${6 / scale}`}
                            style={{ pointerEvents: 'none' }}
                        />
                        {!room.locked && (
                            <EdgeInsertHandle
                                x={insertPoint.x * GRID_SIZE}
                                y={insertPoint.y * GRID_SIZE}
                                scale={scale}
                                onInsert={() => {
                                    const nextPoints = [...roomPoints];
                                    nextPoints.splice(index + 1, 0, insertPoint);
                                    const nextBounds = getRoomBounds({ ...room, points: nextPoints });
                                    updateRoom(room.id, { points: nextPoints, ...nextBounds });
                                }}
                            />
                        )}
                    </g>
                );
            })}
            {isSelected && !room.locked && roomPoints.map((point, index) => (
                <PointHandle
                    key={`${room.id}-point-${index}`}
                    x={point.x * GRID_SIZE}
                    y={point.y * GRID_SIZE}
                    scale={scale}
                    onDragMove={(mx, my, first, memo) => {
                        if (first || !memo) memo = { x: point.x, y: point.y };
                        const newPoint = {
                            x: roundUnit(memo.x + (mx / scale) / GRID_SIZE),
                            y: roundUnit(memo.y + (my / scale) / GRID_SIZE)
                        };
                        const nextPoints = [...roomPoints];
                        nextPoints[index] = newPoint;
                        const nextBounds = getRoomBounds({ ...room, points: nextPoints });
                        updateRoom(room.id, { points: nextPoints, ...nextBounds });
                        return memo;
                    }}
                />
            ))}
        </g>
    );
}

export default function Canvas2D() {
    const {
        floors,
        rooms,
        furniture,
        walls,
        doors,
        cylinders,
        surfaces,
        stairs,
        activeFloorId,
        addWall,
        addDoor,
        addRoom,
        addFurniture,
        addCylinder,
        addStair,
        interactMode,
        setSelectedElement
    } = useStore();

    const containerRef = useRef<HTMLDivElement>(null);
    const [drawingWall, setDrawingWall] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
    const [drawingSurface, setDrawingSurface] = useState<{ points: Point[]; preview?: Point } | null>(null);
    const [scale, setScale] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
    const [distanceGuides, setDistanceGuides] = useState<DistanceGuide[]>([]);
    const [doorPreview, setDoorPreview] = useState<DoorHostCandidate | null>(null);

    const activeFloor = floors.find((floor) => floor.id === activeFloorId);
    const floorsById = useMemo(
        () => new Map(floors.map((floor) => [floor.id, floor])),
        [floors]
    );
    const resolvedDoors = useMemo(
        () => doors
            .map((door) => {
                const placement = resolveDoorPlacement(door, rooms, walls);
                return placement ? { door, placement } : null;
            })
            .filter((entry): entry is { door: Door; placement: NonNullable<ReturnType<typeof resolveDoorPlacement>> } => entry !== null),
        [doors, rooms, walls]
    );
    const stairOpeningsByFloor = useMemo(() => {
        const nextMap = new Map<string, Rect2D[]>();

        stairs.forEach((stair) => {
            const openingFloorId = getStairOpeningFloorId(stair, floorsById);
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
    }, [floorsById, stairs]);
    const visibleRooms = rooms.filter((room) => room.floorId === activeFloorId);
    const visibleFurniture = furniture.filter((item) => item.floorId === activeFloorId);
    const visibleWalls = walls.filter((wall) => wall.floorId === activeFloorId);
    const visibleDoors = useMemo(
        () => resolvedDoors.filter((entry) => entry.placement.floorId === activeFloorId).map((entry) => entry.door),
        [activeFloorId, resolvedDoors]
    );
    const visibleCylinders = cylinders.filter((cylinder) => cylinder.floorId === activeFloorId);
    const visibleSurfaces = surfaces.filter((surface) => surface.floorId === activeFloorId);
    const visibleStairs = stairs.filter((stair) => stair.floorId === activeFloorId);
    const distanceCandidates = useMemo(
        () => [
            ...visibleRooms.map((room) => ({ id: room.id, rect: getObjectBounds(room, 'room') })),
            ...visibleFurniture.map((item) => ({ id: item.id, rect: getObjectBounds(item, 'furniture') })),
            ...visibleCylinders.map((cylinder) => ({ id: cylinder.id, rect: getObjectBounds(cylinder, 'cylinder') })),
            ...visibleStairs.map((stair) => ({ id: stair.id, rect: getObjectBounds(stair, 'stair') })),
            ...visibleWalls.map((wall) => ({ id: wall.id, rect: getObjectBounds(wall, 'wall') }))
        ],
        [visibleCylinders, visibleFurniture, visibleRooms, visibleStairs, visibleWalls]
    );
    const roomOpeningsById = useMemo(() => {
        const nextMap = new Map<string, Rect2D[]>();
        const floorOpenings = stairOpeningsByFloor.get(activeFloorId) || [];

        visibleRooms.forEach((room) => {
            if (Math.abs(room.rotation || 0) > 0.01) {
                nextMap.set(room.id, []);
                return;
            }
            const openings = floorOpenings
                .map((opening) => getRectIntersection(getRoomBounds(room), opening))
                .filter((opening): opening is Rect2D => opening !== null);
            nextMap.set(room.id, openings);
        });

        return nextMap;
    }, [activeFloorId, stairOpeningsByFloor, visibleRooms]);
    const ghostFloors = useMemo(() => {
        const orderedFloors = [...floors].sort((a, b) => a.elevation - b.elevation);
        const activeIndex = orderedFloors.findIndex((floor) => floor.id === activeFloorId);

        return orderedFloors
            .filter((floor) => floor.id !== activeFloorId)
            .map((floor, index) => {
                const floorIndex = orderedFloors.findIndex((item) => item.id === floor.id);
                const distance = Math.abs(floorIndex - activeIndex) || Math.abs(index - activeIndex) || 1;
                const floorRooms = rooms.filter((room) => room.floorId === floor.id);
                const floorOpenings = stairOpeningsByFloor.get(floor.id) || [];
                const roomOpenings = new Map<string, Rect2D[]>();

                floorRooms.forEach((room) => {
                    if (Math.abs(room.rotation || 0) > 0.01) {
                        roomOpenings.set(room.id, []);
                        return;
                    }
                    roomOpenings.set(
                        room.id,
                        floorOpenings
                            .map((opening) => getRectIntersection(getRoomBounds(room), opening))
                            .filter((opening): opening is Rect2D => opening !== null)
                    );
                });

                return {
                    floor,
                    opacity: getGhostFloorOpacity(distance),
                    relation: floorIndex < activeIndex ? 'below' as const : 'above' as const,
                    rooms: floorRooms,
                    walls: walls.filter((wall) => wall.floorId === floor.id),
                    cylinders: cylinders.filter((cylinder) => cylinder.floorId === floor.id),
                    surfaces: surfaces.filter((surface) => surface.floorId === floor.id),
                    stairs: stairs.filter((stair) => stair.floorId === floor.id),
                    doors: resolvedDoors.filter((entry) => entry.placement.floorId === floor.id),
                    roomOpenings
                };
            });
    }, [activeFloorId, cylinders, floors, resolvedDoors, rooms, stairOpeningsByFloor, stairs, surfaces, walls]);

    const defaultTargetFloorId = useMemo(() => {
        const sortedFloors = [...floors].sort((a, b) => a.elevation - b.elevation);
        const activeIndex = sortedFloors.findIndex((floor) => floor.id === activeFloorId);
        return sortedFloors[activeIndex + 1]?.id || sortedFloors[activeIndex - 1]?.id || null;
    }, [activeFloorId, floors]);

    const clearTransientState = () => {
        setIsPanning(false);
        setSnapGuides([]);
        setDistanceGuides([]);
        setDoorPreview(null);
    };

    useEffect(() => {
        setDoorPreview(null);
    }, [activeFloorId, interactMode]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const isTypingTarget = target?.tagName === 'INPUT'
                || target?.tagName === 'TEXTAREA'
                || target?.tagName === 'SELECT'
                || !!target?.isContentEditable;

            if (event.code === 'Space' && !isTypingTarget) {
                event.preventDefault();
                setIsSpacePressed(true);
            }
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === 'Space') {
                setIsSpacePressed(false);
            }
        };

        const handleBlur = () => {
            setIsSpacePressed(false);
            setIsPanning(false);
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', handleBlur);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', handleBlur);
        };
    }, []);

    const toWorldPoint = (clientX: number, clientY: number) => {
        if (!containerRef.current) return null;

        const rect = containerRef.current.getBoundingClientRect();
        return {
            x: roundUnit(((clientX - rect.left - pan.x) / scale) / GRID_SIZE),
            y: roundUnit(((clientY - rect.top - pan.y) / scale) / GRID_SIZE)
        };
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        if (e.button === 1 || e.altKey || isSpacePressed) {
            setIsPanning(true);
            return;
        }

        if (interactMode === 'select') {
            setSelectedElement(null);
        }

        const point = toWorldPoint(e.clientX, e.clientY);
        if (!point) return;

        if (interactMode === 'place_door') {
            const host = findClosestDoorHost(point, visibleRooms, visibleWalls, activeFloorId, DOOR_PLACE_THRESHOLD);
            if (!host) return;

            if (host.hostKind === 'room' && (host.edge || host.edgeIndex !== undefined)) {
                addDoor({
                    hostKind: 'room',
                    roomId: host.hostId,
                    edge: host.edge,
                    edgeIndex: host.edgeIndex,
                    ratio: host.ratio,
                    width: 0.9,
                    doorHeight: 2.1,
                    name: 'Door'
                });
            } else {
                addDoor({
                    hostKind: 'wall',
                    wallId: host.hostId,
                    ratio: host.ratio,
                    width: 0.9,
                    doorHeight: 2.1,
                    name: 'Door'
                });
            }

            setDoorPreview(host);
            return;
        }

        if (interactMode === 'draw_wall') {
            setDrawingWall({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
            return;
        }

        if (interactMode === 'draw_surface') {
            if (!drawingSurface) {
                setDrawingSurface({ points: [point] });
                return;
            }

            const firstPoint = drawingSurface.points[0];
            if (Math.hypot(point.x - firstPoint.x, point.y - firstPoint.y) <= 1 && drawingSurface.points.length >= 3) {
                const xs = drawingSurface.points.map((item) => item.x);
                const ys = drawingSurface.points.map((item) => item.y);
                addRoom({
                    x: Math.min(...xs),
                    y: Math.min(...ys),
                    width: Math.max(...xs) - Math.min(...xs),
                    height: Math.max(...ys) - Math.min(...ys),
                    points: drawingSurface.points,
                    rotation: 0,
                    hiddenWallEdges: [],
                    wallHeight: 3,
                    name: `Room ${visibleRooms.length + 1}`,
                    color: '#ffb8b8'
                });
                setDrawingSurface(null);
                return;
            }

            setDrawingSurface({
                points: [...drawingSurface.points, point],
                preview: point
            });
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (isPanning) {
            setPan((prev) => ({ x: prev.x + e.movementX, y: prev.y + e.movementY }));
            return;
        }

        const point = toWorldPoint(e.clientX, e.clientY);
        if (!point) return;

        if (interactMode === 'place_door') {
            setDoorPreview(findClosestDoorHost(point, visibleRooms, visibleWalls, activeFloorId, DOOR_PLACE_THRESHOLD));
            return;
        }

        if (interactMode === 'draw_wall' && drawingWall) {
            const snapped = snapWallPoint(point, visibleWalls, { x: drawingWall.startX, y: drawingWall.startY });
            setSnapGuides(snapped.guides);
            setDrawingWall((prev) => prev ? { ...prev, currentX: snapped.x, currentY: snapped.y } : null);
        } else if (interactMode === 'draw_surface' && drawingSurface) {
            setDrawingSurface((prev) => prev ? { ...prev, preview: point } : null);
        }
    };

    const handlePointerUp = () => {
        if (isPanning) {
            clearTransientState();
            return;
        }

        if (interactMode === 'draw_wall' && drawingWall) {
            if (drawingWall.startX !== drawingWall.currentX || drawingWall.startY !== drawingWall.currentY) {
                addWall({
                    startX: drawingWall.startX,
                    startY: drawingWall.startY,
                    endX: drawingWall.currentX,
                    endY: drawingWall.currentY
                });
            }
            setDrawingWall(null);
        }

        setSnapGuides([]);
        setDistanceGuides([]);

        if (interactMode !== 'place_door') {
            setDoorPreview(null);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        try {
            const dataStr = e.dataTransfer.getData('application/json');
            if (!dataStr) return;

            const point = toWorldPoint(e.clientX, e.clientY);
            if (!point) return;

            const { type, payload } = JSON.parse(dataStr);

            if (type === 'room') {
                addRoom({ ...payload, x: point.x, y: point.y });
            } else if (type === 'cylinder') {
                addCylinder({ ...payload, x: point.x, y: point.y });
            } else if (type === 'furniture') {
                addFurniture({ ...payload, x: point.x, y: point.y });
            } else if (type === 'stair') {
                if (!payload.targetFloorId && !defaultTargetFloorId) {
                    alert('Create another level first so the stair has a target.');
                    return;
                }
                const fittedRect = integrateRectWithRooms({
                    x: point.x,
                    y: point.y,
                    width: payload.width,
                    height: payload.height
                }, visibleRooms, activeFloorId);
                addStair({
                    ...payload,
                    x: fittedRect.x,
                    y: fittedRect.y,
                    targetFloorId: payload.targetFloorId || defaultTargetFloorId
                });
            }
        } catch (error) {
            console.error('Failed to parse dropped element', error);
        }
    };

    const handleWheel = (e: React.WheelEvent) => {
        e.preventDefault();

        if (e.ctrlKey) {
            const zoomSensitivity = 0.005;
            const nextScale = Math.min(Math.max(0.1, scale - e.deltaY * zoomSensitivity), 5);
            setScale(nextScale);
            return;
        }

        setPan((prev) => ({
            x: prev.x - e.deltaX,
            y: prev.y - e.deltaY
        }));
    };

    const helpText = interactMode === 'place_door'
        ? 'Door tool: click a room edge or drawn wall to place a door.'
        : interactMode === 'draw_surface'
            ? 'Draw Room: click to place points, then click the first point again to close the modular room.'
            : 'Pan: Space + drag or Alt + drag. Zoom: pinch or Ctrl + wheel. Grid is guide-only.';

    const previewDoor = doorPreview
        ? fitDoorToHostSegment(doorPreview, 0.9, 2.1, doorPreview.ratio)
        : null;

    return (
        <div
            ref={containerRef}
            className={`canvas-2d-container ${interactMode !== 'select' ? 'draw-mode' : ''} ${isPanning ? 'panning' : ''} ${isSpacePressed ? 'pan-ready' : ''}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={() => {
                handlePointerUp();
                setDoorPreview(null);
            }}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onWheel={handleWheel}
        >
            <div className="canvas-help">{helpText}</div>
            <div
                className="infinite-grid-overlay"
                style={{
                    backgroundSize: `${GRID_SIZE * scale}px ${GRID_SIZE * scale}px, ${GRID_SIZE * scale}px ${GRID_SIZE * scale}px, ${GRID_SIZE * GRID_MAJOR_UNITS * scale}px ${GRID_SIZE * GRID_MAJOR_UNITS * scale}px, ${GRID_SIZE * GRID_MAJOR_UNITS * scale}px ${GRID_SIZE * GRID_MAJOR_UNITS * scale}px`,
                    backgroundPosition: `${pan.x}px ${pan.y}px, ${pan.x}px ${pan.y}px, ${pan.x}px ${pan.y}px, ${pan.x}px ${pan.y}px`
                }}
            />
            <div
                className="zoom-pan-layer"
                style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                    transformOrigin: '0 0',
                    width: '100%',
                    height: '100%',
                    position: 'absolute'
                }}
            >
                {activeFloor?.reference && (
                    <ReferenceLayer floorId={activeFloor.id} reference={activeFloor.reference} scale={scale} />
                )}

                <div className="ghost-floors-layer" style={{ width: CANVAS_WORLD_SIZE, height: CANVAS_WORLD_SIZE }}>
                    {ghostFloors.map((ghostFloor) => (
                        <div
                            key={ghostFloor.floor.id}
                            className={`ghost-floor ghost-floor-${ghostFloor.relation}`}
                            style={{ opacity: ghostFloor.opacity }}
                        >
                            <svg
                                className="ghost-floor-svg"
                                style={{ width: CANVAS_WORLD_SIZE, height: CANVAS_WORLD_SIZE }}
                            >
                                {ghostFloor.surfaces.map((surface) => (
                                    <polygon
                                        key={surface.id}
                                        points={surface.points.map((point) => `${point.x * GRID_SIZE},${point.y * GRID_SIZE}`).join(' ')}
                                        className="ghost-surface"
                                    />
                                ))}
                                {ghostFloor.rooms.filter((room) => room.points && room.points.length >= 3).map((room) => (
                                    <polygon
                                        key={room.id}
                                        points={(room.points || []).map((point) => `${point.x * GRID_SIZE},${point.y * GRID_SIZE}`).join(' ')}
                                        className="ghost-room-polygon"
                                        fill={room.color || '#dbe7ff'}
                                    />
                                ))}
                                {ghostFloor.walls.map((wall) => (
                                    <line
                                        key={wall.id}
                                        x1={wall.startX * GRID_SIZE + GRID_SIZE / 2}
                                        y1={wall.startY * GRID_SIZE + GRID_SIZE / 2}
                                        x2={wall.endX * GRID_SIZE + GRID_SIZE / 2}
                                        y2={wall.endY * GRID_SIZE + GRID_SIZE / 2}
                                        className="ghost-wall"
                                    />
                                ))}
                                {ghostFloor.doors.map(({ door, placement }) => (
                                    <line
                                        key={door.id}
                                        x1={(placement.center.x - ((placement.width / 2) * Math.cos(placement.angle))) * GRID_SIZE}
                                        y1={(placement.center.y - ((placement.width / 2) * Math.sin(placement.angle))) * GRID_SIZE}
                                        x2={(placement.center.x + ((placement.width / 2) * Math.cos(placement.angle))) * GRID_SIZE}
                                        y2={(placement.center.y + ((placement.width / 2) * Math.sin(placement.angle))) * GRID_SIZE}
                                        className="ghost-door"
                                    />
                                ))}
                            </svg>

                            <div className="ghost-floor-content" style={{ width: CANVAS_WORLD_SIZE, height: CANVAS_WORLD_SIZE }}>
                                {ghostFloor.rooms.map((room) => (
                                    room.points && room.points.length >= 3 ? null : (
                                        <div
                                            key={room.id}
                                            className="ghost-room"
                                            style={{
                                                left: room.x * GRID_SIZE,
                                                top: room.y * GRID_SIZE,
                                                width: room.width * GRID_SIZE,
                                                height: room.height * GRID_SIZE,
                                                backgroundColor: room.color || '#dbe7ff',
                                                transform: `rotate(${room.rotation || 0}deg)`,
                                                transformOrigin: 'center center'
                                            }}
                                        >
                                            {renderRoomOpenings(ghostFloor.roomOpenings.get(room.id) || [], room)}
                                        </div>
                                    )
                                ))}
                                {ghostFloor.cylinders.map((cylinder) => (
                                    <div
                                        key={cylinder.id}
                                        className="ghost-cylinder"
                                        style={{
                                            left: (cylinder.x - cylinder.radius) * GRID_SIZE,
                                            top: (cylinder.y - cylinder.radius) * GRID_SIZE,
                                            width: cylinder.radius * 2 * GRID_SIZE,
                                            height: cylinder.radius * 2 * GRID_SIZE,
                                            backgroundColor: cylinder.color || '#c9f2d0'
                                        }}
                                    />
                                ))}
                                {ghostFloor.stairs.map((stair) => (
                                    <div
                                        key={stair.id}
                                        className="ghost-stair"
                                        style={{
                                            left: stair.x * GRID_SIZE,
                                            top: stair.y * GRID_SIZE,
                                            width: stair.width * GRID_SIZE,
                                            height: stair.height * GRID_SIZE,
                                            backgroundColor: stair.color || '#ffd166'
                                        }}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                <svg
                    className="svg-measurements-layer"
                    style={{ position: 'absolute', width: CANVAS_WORLD_SIZE, height: CANVAS_WORLD_SIZE, pointerEvents: 'none', zIndex: 1 }}
                >
                    {scale > 0.45 && Array.from({ length: Math.floor(CANVAS_WORLD_SIZE / GRID_SIZE) }).map((_, index) => (
                        <g key={index}>
                            {index > 0 && index % 2 === 0 && (
                                <>
                                    <text x={index * GRID_SIZE} y={getAdaptiveTextSize(scale, 14)} fill="rgba(255, 255, 255, 0.4)" fontSize={getAdaptiveTextSize(scale, 10)}>
                                        {toMeters(index)}
                                    </text>
                                    <text x={getAdaptiveTextSize(scale, 5)} y={index * GRID_SIZE + getAdaptiveTextSize(scale, 10)} fill="rgba(255, 255, 255, 0.4)" fontSize={getAdaptiveTextSize(scale, 10)}>
                                        {toMeters(index)}
                                    </text>
                                </>
                            )}
                        </g>
                    ))}
                </svg>

                <svg className="svg-walls-layer" style={{ width: CANVAS_WORLD_SIZE, height: CANVAS_WORLD_SIZE }}>
                    {snapGuides.map((guide, index) => (
                        guide.orientation === 'vertical' ? (
                            <line
                                key={`${guide.orientation}-${guide.position}-${index}`}
                                x1={guide.position * GRID_SIZE}
                                y1={0}
                                x2={guide.position * GRID_SIZE}
                                y2={CANVAS_WORLD_SIZE}
                                className="snap-guide"
                            />
                        ) : (
                            <line
                                key={`${guide.orientation}-${guide.position}-${index}`}
                                x1={0}
                                y1={guide.position * GRID_SIZE}
                                x2={CANVAS_WORLD_SIZE}
                                y2={guide.position * GRID_SIZE}
                                className="snap-guide"
                            />
                        )
                    ))}

                    {distanceGuides.map((guide, index) => (
                        <g key={`distance-guide-${guide.orientation}-${index}`} style={{ pointerEvents: 'none' }}>
                            <line
                                x1={guide.start.x * GRID_SIZE}
                                y1={guide.start.y * GRID_SIZE}
                                x2={guide.end.x * GRID_SIZE}
                                y2={guide.end.y * GRID_SIZE}
                                className="distance-guide-line"
                            />
                            <text
                                x={((guide.start.x + guide.end.x) / 2) * GRID_SIZE}
                                y={((guide.start.y + guide.end.y) / 2) * GRID_SIZE - getAdaptiveTextSize(scale, 8)}
                                className="distance-guide-label"
                                fontSize={getAdaptiveTextSize(scale, 11)}
                                textAnchor="middle"
                            >
                                {toMeters(guide.distance)}
                            </text>
                        </g>
                    ))}

                    {visibleSurfaces.map((surface) => (
                        <SurfaceElement key={surface.id} surface={surface} scale={scale} />
                    ))}

                    {visibleRooms.filter((room) => room.points && room.points.length >= 3).map((room) => (
                        <PolygonRoomElement
                            key={room.id}
                            room={room}
                            scale={scale}
                            distanceCandidates={distanceCandidates}
                            setDistanceGuides={setDistanceGuides}
                        />
                    ))}

                    {drawingSurface && (
                        <g style={{ pointerEvents: 'none' }}>
                            {drawingSurface.points.length > 0 && (
                                <polyline
                                    points={drawingSurface.points.map((point) => `${point.x * GRID_SIZE},${point.y * GRID_SIZE}`).join(' ')}
                                    fill="rgba(100, 150, 255, 0.3)"
                                    stroke="#4a90e2"
                                    strokeWidth={2 / scale}
                                    strokeDasharray="5,5"
                                />
                            )}
                            {drawingSurface.preview && drawingSurface.points.length > 0 && (
                                <line
                                    x1={drawingSurface.points[drawingSurface.points.length - 1].x * GRID_SIZE}
                                    y1={drawingSurface.points[drawingSurface.points.length - 1].y * GRID_SIZE}
                                    x2={drawingSurface.preview.x * GRID_SIZE}
                                    y2={drawingSurface.preview.y * GRID_SIZE}
                                    stroke="#4a90e2"
                                    strokeWidth={2 / scale}
                                    strokeDasharray="5,5"
                                />
                            )}
                            {drawingSurface.points.map((point, index) => (
                                <circle
                                    key={index}
                                    cx={point.x * GRID_SIZE}
                                    cy={point.y * GRID_SIZE}
                                    r={(index === 0 ? 6 : 4) / scale}
                                    fill={index === 0 ? '#ff4444' : '#4a90e2'}
                                />
                            ))}
                        </g>
                    )}

                    {visibleWalls.map((wall) => (
                        <WallElement key={wall.id} wall={wall} scale={scale} walls={visibleWalls} setSnapGuides={setSnapGuides} />
                    ))}

                    {drawingWall && (
                        <WallElement wall={drawingWall} isDrawing scale={scale} walls={visibleWalls} setSnapGuides={setSnapGuides} />
                    )}
                </svg>

                <div className="canvas-2d-content" style={{ pointerEvents: interactMode === 'select' ? 'auto' : 'none', width: CANVAS_WORLD_SIZE, height: CANVAS_WORLD_SIZE }}>
                    {visibleRooms.filter((room) => !room.points || room.points.length < 3).map((room) => (
                        <RoomElement
                            key={room.id}
                            room={room}
                            scale={scale}
                            rooms={visibleRooms}
                            setSnapGuides={setSnapGuides}
                            openings={roomOpeningsById.get(room.id) || []}
                            distanceCandidates={distanceCandidates}
                            setDistanceGuides={setDistanceGuides}
                        />
                    ))}
                    {visibleCylinders.map((cylinder) => (
                        <CylinderElement
                            key={cylinder.id}
                            cylinder={cylinder}
                            scale={scale}
                            distanceCandidates={distanceCandidates}
                            setDistanceGuides={setDistanceGuides}
                        />
                    ))}
                    {visibleStairs.map((stair) => (
                        <StairElement
                            key={stair.id}
                            stair={stair}
                            scale={scale}
                            distanceCandidates={distanceCandidates}
                            setDistanceGuides={setDistanceGuides}
                        />
                    ))}
                    {visibleFurniture.map((item) => (
                        <FurnitureElement
                            key={item.id}
                            item={item}
                            scale={scale}
                            distanceCandidates={distanceCandidates}
                            setDistanceGuides={setDistanceGuides}
                        />
                    ))}
                    {visibleDoors.map((door) => (
                        <DoorElement key={door.id} door={door} scale={scale} />
                    ))}
                    {previewDoor && interactMode === 'place_door' && (
                        <div
                            style={{
                                position: 'absolute',
                                left: previewDoor.center.x * GRID_SIZE,
                                top: previewDoor.center.y * GRID_SIZE,
                                width: previewDoor.width * GRID_SIZE,
                                height: 12,
                                backgroundColor: 'rgba(251, 191, 36, 0.45)',
                                border: '1px dashed rgba(255,255,255,0.75)',
                                borderRadius: 999,
                                transform: `translate(-50%, -50%) rotate(${previewDoor.angle * (180 / Math.PI)}deg)`,
                                pointerEvents: 'none',
                                zIndex: 3
                            }}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
