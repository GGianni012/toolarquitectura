import { useStore, Room, Wall, Furniture, Door, Cylinder, Surface, Stair, FloorReference } from '../../store/useStore';
import { useDrag } from '@use-gesture/react';
import { Sofa, BedDouble, Trees } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    findBestRoomForRect,
    findClosestDoorHost,
    fitDoorToHostSegment,
    fitRectInsideRoom,
    getRectIntersection,
    getStairOpeningFloorId,
    resolveDoorPlacement,
    type DoorHostCandidate,
    type Rect2D
} from '../../utils/buildingGeometry';
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
                transform: `scale(${reference.scale})`,
                transformOrigin: 'top left',
                pointerEvents: reference.locked ? 'none' : 'auto'
            }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            <img src={reference.src} alt={reference.name} className="reference-image" draggable={false} />
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
    openings = []
}: {
    room: Room;
    scale: number;
    rooms: Room[];
    setSnapGuides: (guides: SnapGuide[]) => void;
    openings?: Rect2D[];
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
                boxShadow: isSelected ? '0 0 0 3px #fca5a5' : undefined
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

function FurnitureElement({ item, scale }: { item: Furniture; scale: number }) {
    const { updateFurniture, interactMode, selectedElement, setSelectedElement } = useStore();
    const isSelected = selectedElement?.id === item.id;
    const width = item.width ?? 1;
    const depth = item.depth ?? 1;

    const bind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (interactMode !== 'select' || item.locked) return memo;
        if (first || !memo) memo = { x: item.x, y: item.y };

        updateFurniture(item.id, {
            x: roundUnit(memo.x + (mx / scale) / GRID_SIZE),
            y: roundUnit(memo.y + (my / scale) / GRID_SIZE)
        });

        return memo;
    }, {
        enabled: interactMode === 'select' && !item.locked
    });

    const getIcon = () => {
        switch (item.type) {
            case 'sofa': return <Sofa size={32} />;
            case 'bed': return <BedDouble size={32} />;
            case 'plant': return <Trees size={32} color="#4ade80" />;
            default: return null;
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
                backgroundColor: item.color || 'rgba(255, 255, 255, 0.1)',
                boxShadow: isSelected ? '0 0 0 3px #fca5a5' : undefined
            }}
        >
            {getIcon()}
        </div>
    );
}

function CylinderElement({ cylinder, scale }: { cylinder: Cylinder; scale: number }) {
    const { updateCylinder, interactMode, selectedElement, setSelectedElement } = useStore();
    const isSelected = selectedElement?.id === cylinder.id;

    const bind = useDrag(({ movement: [mx, my], first, memo }) => {
        if (interactMode !== 'select' || cylinder.locked) return memo;
        if (first || !memo) memo = { x: cylinder.x, y: cylinder.y };

        updateCylinder(cylinder.id, {
            x: roundUnit(memo.x + (mx / scale) / GRID_SIZE),
            y: roundUnit(memo.y + (my / scale) / GRID_SIZE)
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

function StairElement({ stair, scale }: { stair: Stair; scale: number }) {
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

        updateStair(stair.id, {
            x: nextRect.x,
            y: nextRect.y
        });

        return memo;
    }, { enabled: interactMode === 'select' && !stair.locked });
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
        addSurface,
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
    const roomOpeningsById = useMemo(() => {
        const nextMap = new Map<string, Rect2D[]>();
        const floorOpenings = stairOpeningsByFloor.get(activeFloorId) || [];

        visibleRooms.forEach((room) => {
            const openings = floorOpenings
                .map((opening) => getRectIntersection(room, opening))
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
                    roomOpenings.set(
                        room.id,
                        floorOpenings
                            .map((opening) => getRectIntersection(room, opening))
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

            if (host.hostKind === 'room' && host.edge) {
                addDoor({
                    hostKind: 'room',
                    roomId: host.hostId,
                    edge: host.edge,
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
                addSurface({ points: drawingSurface.points });
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
                                    <div
                                        key={room.id}
                                        className="ghost-room"
                                        style={{
                                            left: room.x * GRID_SIZE,
                                            top: room.y * GRID_SIZE,
                                            width: room.width * GRID_SIZE,
                                            height: room.height * GRID_SIZE,
                                            backgroundColor: room.color || '#dbe7ff'
                                        }}
                                    >
                                        {renderRoomOpenings(ghostFloor.roomOpenings.get(room.id) || [], room)}
                                    </div>
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

                    {visibleSurfaces.map((surface) => (
                        <SurfaceElement key={surface.id} surface={surface} scale={scale} />
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
                    {visibleRooms.map((room) => (
                        <RoomElement
                            key={room.id}
                            room={room}
                            scale={scale}
                            rooms={visibleRooms}
                            setSnapGuides={setSnapGuides}
                            openings={roomOpeningsById.get(room.id) || []}
                        />
                    ))}
                    {visibleCylinders.map((cylinder) => (
                        <CylinderElement key={cylinder.id} cylinder={cylinder} scale={scale} />
                    ))}
                    {visibleStairs.map((stair) => (
                        <StairElement key={stair.id} stair={stair} scale={scale} />
                    ))}
                    {visibleFurniture.map((item) => (
                        <FurnitureElement key={item.id} item={item} scale={scale} />
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
