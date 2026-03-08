import type { Door, DoorHostKind, Floor, Room, RoomEdge, Wall } from '../store/useStore';

const EPSILON = 0.0001;
const MIN_DOOR_MARGIN = 0.08;
const DEFAULT_ROOM_WALL_HEIGHT = 3.2;
const ROOM_EDGES: RoomEdge[] = ['north', 'south', 'east', 'west'];

export type Point2D = { x: number; y: number };
export type SegmentOrientation = 'horizontal' | 'vertical' | 'angled';

export interface DoorHostSegment {
    hostKind: DoorHostKind;
    hostId: string;
    floorId: string;
    edge?: RoomEdge;
    start: Point2D;
    end: Point2D;
    length: number;
    angle: number;
    orientation: SegmentOrientation;
}

export interface FittedDoorPlacement extends DoorHostSegment {
    width: number;
    doorHeight: number;
    ratio: number;
    centerDistance: number;
    startDistance: number;
    endDistance: number;
    center: Point2D;
}

export interface DoorHostCandidate extends DoorHostSegment {
    ratio: number;
    distance: number;
    projectionDistance: number;
}

interface RoomEdgeContribution {
    roomId: string;
    edge: RoomEdge;
    height: number;
}

export interface RoomWallSegment {
    id: string;
    floorId: string;
    start: Point2D;
    end: Point2D;
    length: number;
    angle: number;
    orientation: 'horizontal' | 'vertical';
    height: number;
    contributors: RoomEdgeContribution[];
    visible: boolean;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function keyForNumber(value: number) {
    return value.toFixed(4);
}

function uniqueSorted(values: number[]) {
    return Array.from(new Set(values.map((value) => Number(keyForNumber(value))))).sort((a, b) => a - b);
}

function getSegmentOrientation(start: Point2D, end: Point2D): SegmentOrientation {
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    if (Math.abs(dy) <= EPSILON) return 'horizontal';
    if (Math.abs(dx) <= EPSILON) return 'vertical';
    return 'angled';
}

function buildSegment(hostKind: DoorHostKind, hostId: string, floorId: string, start: Point2D, end: Point2D, edge?: RoomEdge): DoorHostSegment {
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    return {
        hostKind,
        hostId,
        floorId,
        edge,
        start,
        end,
        length: Math.hypot(dx, dy),
        angle: Math.atan2(dy, dx),
        orientation: getSegmentOrientation(start, end)
    };
}

export function getDoorHostKind(door: Door): DoorHostKind | null {
    if (door.hostKind) return door.hostKind;
    if (door.roomId && door.edge) return 'room';
    if (door.wallId) return 'wall';
    return null;
}

export function getRoomEdgeSegment(room: Room, edge: RoomEdge): DoorHostSegment {
    switch (edge) {
        case 'north':
            return buildSegment('room', room.id, room.floorId, { x: room.x, y: room.y }, { x: room.x + room.width, y: room.y }, edge);
        case 'south':
            return buildSegment('room', room.id, room.floorId, { x: room.x, y: room.y + room.height }, { x: room.x + room.width, y: room.y + room.height }, edge);
        case 'east':
            return buildSegment('room', room.id, room.floorId, { x: room.x + room.width, y: room.y }, { x: room.x + room.width, y: room.y + room.height }, edge);
        case 'west':
            return buildSegment('room', room.id, room.floorId, { x: room.x, y: room.y }, { x: room.x, y: room.y + room.height }, edge);
    }
}

export function getWallSegment(wall: Wall): DoorHostSegment {
    return buildSegment('wall', wall.id, wall.floorId, { x: wall.startX, y: wall.startY }, { x: wall.endX, y: wall.endY });
}

export function resolveDoorHostSegment(door: Door, rooms: Room[], walls: Wall[]): DoorHostSegment | null {
    const hostKind = getDoorHostKind(door);

    if (hostKind === 'room' && door.roomId && door.edge) {
        const room = rooms.find((item) => item.id === door.roomId);
        return room ? getRoomEdgeSegment(room, door.edge) : null;
    }

    if (door.wallId) {
        const wall = walls.find((item) => item.id === door.wallId);
        return wall ? getWallSegment(wall) : null;
    }

    return null;
}

function projectPointToSegment(point: Point2D, start: Point2D, end: Point2D) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared <= EPSILON) {
        return null;
    }

    const rawRatio = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
    const ratio = clamp(rawRatio, 0, 1);
    const projected = {
        x: start.x + dx * ratio,
        y: start.y + dy * ratio
    };

    return {
        ratio,
        projected,
        distance: Math.hypot(point.x - projected.x, point.y - projected.y),
        projectionDistance: Math.sqrt(lengthSquared) * ratio
    };
}

function getFittedDoorWidth(requestedWidth: number, length: number) {
    if (length <= EPSILON) return 0;

    const nextWidth = Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : 0.9;
    const minWidth = Math.min(0.2, length);
    const maxWidth = Math.max(
        Math.min(length - MIN_DOOR_MARGIN * 2, length * 0.92),
        minWidth
    );

    return clamp(nextWidth, minWidth, Math.min(maxWidth, length));
}

export function fitDoorToHostSegment(
    host: DoorHostSegment,
    width: number,
    doorHeight: number,
    ratio: number
): FittedDoorPlacement | null {
    if (host.length <= EPSILON) return null;

    const fittedWidth = getFittedDoorWidth(width, host.length);
    const halfWidth = fittedWidth / 2;
    const requestedCenter = clamp(ratio, 0, 1) * host.length;
    const centerDistance = clamp(requestedCenter, halfWidth, Math.max(halfWidth, host.length - halfWidth));
    const normalizedRatio = centerDistance / host.length;
    const center = {
        x: host.start.x + (host.end.x - host.start.x) * normalizedRatio,
        y: host.start.y + (host.end.y - host.start.y) * normalizedRatio
    };

    return {
        ...host,
        width: fittedWidth,
        doorHeight,
        ratio: normalizedRatio,
        centerDistance,
        startDistance: centerDistance - halfWidth,
        endDistance: centerDistance + halfWidth,
        center
    };
}

export function resolveDoorPlacement(door: Door, rooms: Room[], walls: Wall[]) {
    const host = resolveDoorHostSegment(door, rooms, walls);
    if (!host) return null;

    return fitDoorToHostSegment(host, door.width, door.doorHeight || 2.1, door.ratio);
}

export function findClosestDoorHost(
    point: Point2D,
    rooms: Room[],
    walls: Wall[],
    floorId: string,
    maxDistance = 0.45
): DoorHostCandidate | null {
    const candidates: DoorHostCandidate[] = [];

    walls
        .filter((wall) => wall.floorId === floorId)
        .forEach((wall) => {
            const host = getWallSegment(wall);
            const projection = projectPointToSegment(point, host.start, host.end);
            if (!projection || projection.distance > maxDistance) return;

            candidates.push({
                ...host,
                ratio: projection.ratio,
                distance: projection.distance,
                projectionDistance: projection.projectionDistance
            });
        });

    rooms
        .filter((room) => room.floorId === floorId)
        .forEach((room) => {
            ROOM_EDGES.forEach((edge) => {
                const host = getRoomEdgeSegment(room, edge);
                const projection = projectPointToSegment(point, host.start, host.end);
                if (!projection || projection.distance > maxDistance) return;

                candidates.push({
                    ...host,
                    ratio: projection.ratio,
                    distance: projection.distance,
                    projectionDistance: projection.projectionDistance
                });
            });
        });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
        if (a.distance !== b.distance) {
            return a.distance - b.distance;
        }
        if (a.hostKind !== b.hostKind) {
            return a.hostKind === 'wall' ? -1 : 1;
        }
        return Math.abs(a.ratio - 0.5) - Math.abs(b.ratio - 0.5);
    });

    return candidates[0];
}

export function buildRoomWallSegments(rooms: Room[], floors: Floor[]) {
    const floorMap = new Map(floors.map((floor) => [floor.id, floor]));
    const groupedEdges = new Map<string, Array<{
        floorId: string;
        orientation: 'horizontal' | 'vertical';
        axis: number;
        spanStart: number;
        spanEnd: number;
        roomId: string;
        edge: RoomEdge;
        height: number;
    }>>();

    rooms.forEach((room) => {
        const floor = floorMap.get(room.floorId);
        const height = room.wallHeight || floor?.height || DEFAULT_ROOM_WALL_HEIGHT;

        ROOM_EDGES.forEach((edge) => {
            const segment = getRoomEdgeSegment(room, edge);
            if (segment.orientation === 'angled') return;

            const axis = segment.orientation === 'horizontal' ? segment.start.y : segment.start.x;
            const spanStart = segment.orientation === 'horizontal'
                ? Math.min(segment.start.x, segment.end.x)
                : Math.min(segment.start.y, segment.end.y);
            const spanEnd = segment.orientation === 'horizontal'
                ? Math.max(segment.start.x, segment.end.x)
                : Math.max(segment.start.y, segment.end.y);
            const key = `${segment.floorId}:${segment.orientation}:${keyForNumber(axis)}`;
            const bucket = groupedEdges.get(key) || [];

            bucket.push({
                floorId: segment.floorId,
                orientation: segment.orientation,
                axis,
                spanStart,
                spanEnd,
                roomId: room.id,
                edge,
                height
            });

            groupedEdges.set(key, bucket);
        });
    });

    const segments: RoomWallSegment[] = [];

    groupedEdges.forEach((edges) => {
        if (edges.length === 0) return;

        const floor = floorMap.get(edges[0].floorId);
        const points = uniqueSorted(edges.flatMap((edge) => [edge.spanStart, edge.spanEnd]));

        for (let index = 0; index < points.length - 1; index += 1) {
            const spanStart = points[index];
            const spanEnd = points[index + 1];

            if (spanEnd - spanStart <= EPSILON) continue;

            const midpoint = (spanStart + spanEnd) / 2;
            const contributors = edges.filter((edge) => midpoint >= edge.spanStart - EPSILON && midpoint <= edge.spanEnd + EPSILON);
            if (contributors.length === 0) continue;

            const orientation = edges[0].orientation;
            const axis = edges[0].axis;
            const start = orientation === 'horizontal'
                ? { x: spanStart, y: axis }
                : { x: axis, y: spanStart };
            const end = orientation === 'horizontal'
                ? { x: spanEnd, y: axis }
                : { x: axis, y: spanEnd };
            const visible = floor
                ? floor.openSide === 'none' || contributors.some((contributor) => contributor.edge !== floor.openSide)
                : true;

            segments.push({
                id: `${edges[0].floorId}:${orientation}:${keyForNumber(axis)}:${keyForNumber(spanStart)}:${keyForNumber(spanEnd)}`,
                floorId: edges[0].floorId,
                start,
                end,
                length: Math.hypot(end.x - start.x, end.y - start.y),
                angle: Math.atan2(end.y - start.y, end.x - start.x),
                orientation,
                height: Math.max(...contributors.map((contributor) => contributor.height)),
                contributors: contributors.map((contributor) => ({
                    roomId: contributor.roomId,
                    edge: contributor.edge,
                    height: contributor.height
                })),
                visible
            });
        }
    });

    return segments;
}

export function subtractWallOverlapsFromRoomSegments(roomSegments: RoomWallSegment[], walls: Wall[]) {
    const wallCoverage = new Map<string, Array<{ start: number; end: number }>>();

    walls.forEach((wall) => {
        const segment = getWallSegment(wall);
        if (segment.orientation === 'angled') return;

        const axis = segment.orientation === 'horizontal' ? segment.start.y : segment.start.x;
        const spanStart = segment.orientation === 'horizontal'
            ? Math.min(segment.start.x, segment.end.x)
            : Math.min(segment.start.y, segment.end.y);
        const spanEnd = segment.orientation === 'horizontal'
            ? Math.max(segment.start.x, segment.end.x)
            : Math.max(segment.start.y, segment.end.y);
        const key = `${segment.floorId}:${segment.orientation}:${keyForNumber(axis)}`;
        const intervals = wallCoverage.get(key) || [];

        intervals.push({ start: spanStart, end: spanEnd });
        wallCoverage.set(key, intervals);
    });

    wallCoverage.forEach((intervals, key) => {
        const merged = intervals
            .slice()
            .sort((a, b) => a.start - b.start)
            .reduce<Array<{ start: number; end: number }>>((memo, interval) => {
                const last = memo[memo.length - 1];
                if (!last || interval.start > last.end + EPSILON) {
                    memo.push({ ...interval });
                    return memo;
                }

                last.end = Math.max(last.end, interval.end);
                return memo;
            }, []);

        wallCoverage.set(key, merged);
    });

    return roomSegments.flatMap((segment) => {
        const axis = segment.orientation === 'horizontal' ? segment.start.y : segment.start.x;
        const spanStart = segment.orientation === 'horizontal'
            ? Math.min(segment.start.x, segment.end.x)
            : Math.min(segment.start.y, segment.end.y);
        const spanEnd = segment.orientation === 'horizontal'
            ? Math.max(segment.start.x, segment.end.x)
            : Math.max(segment.start.y, segment.end.y);
        const key = `${segment.floorId}:${segment.orientation}:${keyForNumber(axis)}`;
        const overlaps = wallCoverage.get(key);

        if (!overlaps || overlaps.length === 0) {
            return [segment];
        }

        const pieces: RoomWallSegment[] = [];
        let cursor = spanStart;

        overlaps.forEach((overlap, index) => {
            const clippedStart = Math.max(overlap.start, spanStart);
            const clippedEnd = Math.min(overlap.end, spanEnd);
            if (clippedEnd - clippedStart <= EPSILON) return;

            if (clippedStart - cursor > EPSILON) {
                const start = segment.orientation === 'horizontal'
                    ? { x: cursor, y: axis }
                    : { x: axis, y: cursor };
                const end = segment.orientation === 'horizontal'
                    ? { x: clippedStart, y: axis }
                    : { x: axis, y: clippedStart };

                pieces.push({
                    ...segment,
                    id: `${segment.id}:slice:${index}:${keyForNumber(cursor)}:${keyForNumber(clippedStart)}`,
                    start,
                    end,
                    length: Math.hypot(end.x - start.x, end.y - start.y),
                    angle: Math.atan2(end.y - start.y, end.x - start.x)
                });
            }

            cursor = Math.max(cursor, clippedEnd);
        });

        if (spanEnd - cursor > EPSILON) {
            const start = segment.orientation === 'horizontal'
                ? { x: cursor, y: axis }
                : { x: axis, y: cursor };
            const end = segment.orientation === 'horizontal'
                ? { x: spanEnd, y: axis }
                : { x: axis, y: spanEnd };

            pieces.push({
                ...segment,
                id: `${segment.id}:slice:tail:${keyForNumber(cursor)}:${keyForNumber(spanEnd)}`,
                start,
                end,
                length: Math.hypot(end.x - start.x, end.y - start.y),
                angle: Math.atan2(end.y - start.y, end.x - start.x)
            });
        }

        return pieces;
    });
}
