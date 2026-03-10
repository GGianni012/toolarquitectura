import type { FloorReference, Room, Wall } from '../store/useStore';
import { drawTransformedReferenceImage } from './referenceTransforms';

const GRID_SIZE = 50;
const ANALYSIS_MAX_SIZE = 280;
const BAND_POSITION_TOLERANCE = 2;
const BAND_SPAN_TOLERANCE = 6;
const ROOM_COLORS = ['#88ccff', '#c4f1be', '#ffd3a8', '#f8b4c2', '#d2c1ff', '#b8f0ea'];

type TraceWall = Omit<Wall, 'id' | 'floorId'>;
type TraceRoom = Omit<Room, 'id' | 'floorId'>;

type TraceResult = {
    walls: TraceWall[];
    rooms: TraceRoom[];
};

type SegmentRun = {
    start: number;
    end: number;
    pos: number;
};

type MergedBand = {
    minPos: number;
    maxPos: number;
    totalStart: number;
    totalEnd: number;
    count: number;
    avgStart: number;
    avgEnd: number;
};

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function roundUnit(value: number) {
    return Math.round(value * 100) / 100;
}

function loadImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Failed to load the reference image'));
        image.src = src;
    });
}

function despeckleMask(mask: Uint8Array, width: number, height: number) {
    const next = new Uint8Array(mask.length);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            if (!mask[index]) continue;

            let neighbors = 0;
            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    if (mask[ny * width + nx]) {
                        neighbors += 1;
                    }
                }
            }

            if (neighbors >= 2) {
                next[index] = 1;
            }
        }
    }

    return next;
}

function dilateMask(source: Uint8Array, width: number, height: number, radius: number) {
    const next = new Uint8Array(source.length);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            if (!source[index]) continue;

            for (let dy = -radius; dy <= radius; dy += 1) {
                for (let dx = -radius; dx <= radius; dx += 1) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    next[ny * width + nx] = 1;
                }
            }
        }
    }

    return next;
}

function detectHorizontalRuns(mask: Uint8Array, width: number, height: number, minRunLength: number) {
    const runs: SegmentRun[] = [];

    for (let y = 0; y < height; y += 1) {
        let x = 0;
        while (x < width) {
            while (x < width && !mask[y * width + x]) {
                x += 1;
            }

            const start = x;
            while (x < width && mask[y * width + x]) {
                x += 1;
            }

            const end = x - 1;
            if (end - start + 1 >= minRunLength) {
                runs.push({ start, end, pos: y });
            }
        }
    }

    return runs;
}

function detectVerticalRuns(mask: Uint8Array, width: number, height: number, minRunLength: number) {
    const runs: SegmentRun[] = [];

    for (let x = 0; x < width; x += 1) {
        let y = 0;
        while (y < height) {
            while (y < height && !mask[y * width + x]) {
                y += 1;
            }

            const start = y;
            while (y < height && mask[y * width + x]) {
                y += 1;
            }

            const end = y - 1;
            if (end - start + 1 >= minRunLength) {
                runs.push({ start, end, pos: x });
            }
        }
    }

    return runs;
}

function mergeRunsIntoBands(runs: SegmentRun[]) {
    const bands: MergedBand[] = [];

    runs.forEach((run) => {
        const band = [...bands].reverse().find((candidate) =>
            run.pos <= candidate.maxPos + BAND_POSITION_TOLERANCE
            && Math.abs(run.start - candidate.avgStart) <= BAND_SPAN_TOLERANCE
            && Math.abs(run.end - candidate.avgEnd) <= BAND_SPAN_TOLERANCE
        );

        if (!band) {
            bands.push({
                minPos: run.pos,
                maxPos: run.pos,
                totalStart: run.start,
                totalEnd: run.end,
                count: 1,
                avgStart: run.start,
                avgEnd: run.end
            });
            return;
        }

        band.minPos = Math.min(band.minPos, run.pos);
        band.maxPos = Math.max(band.maxPos, run.pos);
        band.totalStart += run.start;
        band.totalEnd += run.end;
        band.count += 1;
        band.avgStart = band.totalStart / band.count;
        band.avgEnd = band.totalEnd / band.count;
    });

    return bands;
}

function findInteriorRooms(mask: Uint8Array, width: number, height: number) {
    const visited = new Uint8Array(mask.length);
    const rooms: Array<{ minX: number; maxX: number; minY: number; maxY: number; area: number }> = [];
    const minArea = Math.max(120, Math.round(width * height * 0.0022));

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const startIndex = y * width + x;
            if (visited[startIndex] || mask[startIndex]) continue;

            const queue = [startIndex];
            visited[startIndex] = 1;
            let touchesBorder = false;
            let area = 0;
            let minX = x;
            let maxX = x;
            let minY = y;
            let maxY = y;

            while (queue.length > 0) {
                const index = queue.pop()!;
                const currentX = index % width;
                const currentY = Math.floor(index / width);
                area += 1;
                minX = Math.min(minX, currentX);
                maxX = Math.max(maxX, currentX);
                minY = Math.min(minY, currentY);
                maxY = Math.max(maxY, currentY);

                if (currentX === 0 || currentY === 0 || currentX === width - 1 || currentY === height - 1) {
                    touchesBorder = true;
                }

                const neighbors = [
                    index - 1,
                    index + 1,
                    index - width,
                    index + width
                ];

                neighbors.forEach((neighborIndex) => {
                    if (neighborIndex < 0 || neighborIndex >= mask.length) return;
                    const neighborX = neighborIndex % width;
                    const neighborY = Math.floor(neighborIndex / width);
                    if (Math.abs(neighborX - currentX) + Math.abs(neighborY - currentY) !== 1) return;
                    if (visited[neighborIndex] || mask[neighborIndex]) return;
                    visited[neighborIndex] = 1;
                    queue.push(neighborIndex);
                });
            }

            if (touchesBorder || area < minArea) continue;

            const spanX = maxX - minX + 1;
            const spanY = maxY - minY + 1;
            const fillRatio = area / Math.max(spanX * spanY, 1);

            if (spanX < 12 || spanY < 12 || fillRatio < 0.42) continue;
            if (spanX > width * 0.94 || spanY > height * 0.94) continue;

            rooms.push({ minX, maxX, minY, maxY, area });
        }
    }

    return rooms.sort((a, b) => b.area - a.area).slice(0, 24);
}

function dedupeWalls(walls: TraceWall[]) {
    const merged: TraceWall[] = [];

    walls.forEach((wall) => {
        const isHorizontal = Math.abs(wall.endY - wall.startY) <= Math.abs(wall.endX - wall.startX);
        const existing = merged.find((candidate) => {
            const candidateHorizontal = Math.abs(candidate.endY - candidate.startY) <= Math.abs(candidate.endX - candidate.startX);
            if (candidateHorizontal !== isHorizontal) return false;

            if (isHorizontal) {
                return Math.abs(candidate.startY - wall.startY) < 0.12
                    && Math.abs(candidate.startX - wall.startX) < 0.25
                    && Math.abs(candidate.endX - wall.endX) < 0.25;
            }

            return Math.abs(candidate.startX - wall.startX) < 0.12
                && Math.abs(candidate.startY - wall.startY) < 0.25
                && Math.abs(candidate.endY - wall.endY) < 0.25;
        });

        if (!existing) {
            merged.push(wall);
            return;
        }

        if (isHorizontal) {
            const averageY = roundUnit((existing.startY + wall.startY) / 2);
            existing.startX = Math.min(existing.startX, wall.startX);
            existing.endX = Math.max(existing.endX, wall.endX);
            existing.startY = averageY;
            existing.endY = averageY;
        } else {
            const averageX = roundUnit((existing.startX + wall.startX) / 2);
            existing.startY = Math.min(existing.startY, wall.startY);
            existing.endY = Math.max(existing.endY, wall.endY);
            existing.startX = averageX;
            existing.endX = averageX;
        }
        existing.thickness = Math.max(existing.thickness || 0.12, wall.thickness || 0.12);
    });

    return merged;
}

export async function autoTraceReference(
    reference: FloorReference,
    options?: { wallHeight?: number }
): Promise<TraceResult> {
    const image = await loadImage(reference.src);
    const transformedCanvas = document.createElement('canvas');
    const transformedContext = transformedCanvas.getContext('2d');

    if (!transformedContext) {
        throw new Error('Canvas 2D context is not available for transformed tracing');
    }

    const transformedSize = drawTransformedReferenceImage(
        transformedContext,
        image,
        image.naturalWidth,
        image.naturalHeight,
        {
            rotation: reference.rotation,
            flipX: reference.flipX,
            flipY: reference.flipY
        }
    );
    const scaleRatio = Math.min(ANALYSIS_MAX_SIZE / Math.max(transformedSize.width, transformedSize.height), 1);
    const width = Math.max(32, Math.round(transformedSize.width * scaleRatio));
    const height = Math.max(32, Math.round(transformedSize.height * scaleRatio));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (!context) {
        throw new Error('Canvas 2D context is not available for auto tracing');
    }

    canvas.width = width;
    canvas.height = height;
    context.drawImage(transformedCanvas, 0, 0, width, height);

    const imageData = context.getImageData(0, 0, width, height);
    const grayscale = new Uint8Array(width * height);
    let brightnessTotal = 0;

    for (let index = 0; index < imageData.data.length; index += 4) {
        const pixelIndex = index / 4;
        const red = imageData.data[index];
        const green = imageData.data[index + 1];
        const blue = imageData.data[index + 2];
        const alpha = imageData.data[index + 3];
        const value = alpha < 40 ? 255 : Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
        grayscale[pixelIndex] = value;
        brightnessTotal += value;
    }

    const averageBrightness = brightnessTotal / grayscale.length;
    const darknessThreshold = clamp(averageBrightness - 35, 95, 205);
    const baseMask = new Uint8Array(width * height);

    for (let index = 0; index < grayscale.length; index += 1) {
        if (grayscale[index] <= darknessThreshold) {
            baseMask[index] = 1;
        }
    }

    const wallMask = dilateMask(dilateMask(despeckleMask(baseMask, width, height), width, height, 1), width, height, 1);
    const horizontalRuns = detectHorizontalRuns(wallMask, width, height, Math.max(14, Math.round(width * 0.08)));
    const verticalRuns = detectVerticalRuns(wallMask, width, height, Math.max(14, Math.round(height * 0.08)));
    const horizontalBands = mergeRunsIntoBands(horizontalRuns);
    const verticalBands = mergeRunsIntoBands(verticalRuns);
    const scaleX = transformedSize.width / width;
    const scaleY = transformedSize.height / height;
    const toWorldX = (pixelX: number) => roundUnit((reference.offsetX + (pixelX * scaleX * reference.scale)) / GRID_SIZE);
    const toWorldY = (pixelY: number) => roundUnit((reference.offsetY + (pixelY * scaleY * reference.scale)) / GRID_SIZE);

    const walls: TraceWall[] = [
        ...horizontalBands.map((band, index) => {
            const startX = toWorldX(band.avgStart);
            const endX = toWorldX(band.avgEnd);
            const y = toWorldY((band.minPos + band.maxPos) / 2);
            const thickness = roundUnit(Math.max(0.12, (((band.maxPos - band.minPos + 1) * scaleY * reference.scale) / GRID_SIZE)));

            return {
                startX,
                startY: y,
                endX,
                endY: y,
                thickness,
                wallHeight: options?.wallHeight || 3,
                color: '#f0f0f0',
                name: `Traced Wall H${index + 1}`
            };
        }),
        ...verticalBands.map((band, index) => {
            const x = toWorldX((band.minPos + band.maxPos) / 2);
            const startY = toWorldY(band.avgStart);
            const endY = toWorldY(band.avgEnd);
            const thickness = roundUnit(Math.max(0.12, (((band.maxPos - band.minPos + 1) * scaleX * reference.scale) / GRID_SIZE)));

            return {
                startX: x,
                startY,
                endX: x,
                endY,
                thickness,
                wallHeight: options?.wallHeight || 3,
                color: '#f0f0f0',
                name: `Traced Wall V${index + 1}`
            };
        })
    ]
        .filter((wall) => Math.hypot(wall.endX - wall.startX, wall.endY - wall.startY) >= 0.45)
        .slice(0, 160);

    const roomRegions = findInteriorRooms(wallMask, width, height);
    const rooms = roomRegions
        .map((region, index) => {
            const x = toWorldX(region.minX);
            const y = toWorldY(region.minY);
            const maxX = toWorldX(region.maxX);
            const maxY = toWorldY(region.maxY);
            const tracedWidth = roundUnit(Math.max(0.6, maxX - x));
            const tracedHeight = roundUnit(Math.max(0.6, maxY - y));

            return {
                x,
                y,
                width: tracedWidth,
                height: tracedHeight,
                rotation: 0,
                wallHeight: options?.wallHeight || 3,
                showWalls: false,
                hiddenWallEdges: [0, 1, 2, 3],
                color: ROOM_COLORS[index % ROOM_COLORS.length],
                name: `Traced Room ${index + 1}`
            };
        })
        .filter((room) => room.width >= 0.6 && room.height >= 0.6);

    return {
        walls: dedupeWalls(walls),
        rooms
    };
}
