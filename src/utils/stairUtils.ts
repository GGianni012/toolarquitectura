import type { Floor, Stair, StairDirection, StairKind } from '../store/useStore';

export function getStairKind(stair: Partial<Stair>) {
    return (stair.kind || 'straight') as StairKind;
}

export function directionToAngle(direction: StairDirection) {
    switch (direction) {
        case 'east':
            return 0;
        case 'south':
            return 90;
        case 'west':
            return 180;
        case 'north':
        default:
            return 270;
    }
}

export function clampSpiralCoreRadius(width: number, height: number, coreRadius?: number) {
    const maxRadius = Math.max(0.16, Math.min(width, height) / 2 - 0.16);
    const nextRadius = coreRadius ?? Math.min(width, height) * 0.18;
    return Math.min(Math.max(nextRadius, 0.16), maxRadius);
}

export function resolvePreferredStairTargetFloorId(
    floors: Floor[],
    sourceFloorId?: string,
    requestedTargetFloorId?: string | null
) {
    const sourceFloor = sourceFloorId ? floors.find((floor) => floor.id === sourceFloorId) : null;
    const validRequestedFloor = requestedTargetFloorId
        ? floors.find((floor) => floor.id === requestedTargetFloorId && floor.id !== sourceFloorId)
        : null;

    if (validRequestedFloor) {
        return validRequestedFloor.id;
    }

    if (!sourceFloor) {
        return floors[0]?.id || null;
    }

    return floors
        .filter((floor) => floor.id !== sourceFloor.id)
        .sort((a, b) => {
            const aDelta = Math.abs(a.elevation - sourceFloor.elevation);
            const bDelta = Math.abs(b.elevation - sourceFloor.elevation);

            if (Math.abs(aDelta - bDelta) > 0.001) {
                return aDelta - bDelta;
            }

            const aIsAbove = a.elevation > sourceFloor.elevation;
            const bIsAbove = b.elevation > sourceFloor.elevation;
            if (aIsAbove !== bIsAbove) {
                return aIsAbove ? 1 : -1;
            }

            return a.elevation - b.elevation;
        })[0]?.id || null;
}

export function getStairDefaults(stair: Partial<Stair>) {
    const width = stair.width ?? 2;
    const height = stair.height ?? 4;

    return {
        kind: getStairKind(stair),
        spin: stair.spin || 'clockwise',
        turns: stair.turns ?? 1.25,
        stepCount: stair.stepCount ?? 16,
        startAngle: stair.startAngle ?? directionToAngle(stair.direction || 'north'),
        coreRadius: clampSpiralCoreRadius(width, height, stair.coreRadius)
    };
}
