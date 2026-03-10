export function normalizeReferenceRotation(rotation = 0) {
    const quarterTurns = ((Math.round(rotation / 90) % 4) + 4) % 4;
    return quarterTurns * 90;
}

export function getReferenceRotatedSize(width: number, height: number, rotation = 0) {
    const normalizedRotation = normalizeReferenceRotation(rotation);
    return normalizedRotation % 180 === 0
        ? { width, height }
        : { width: height, height: width };
}

export function drawTransformedReferenceImage(
    context: CanvasRenderingContext2D,
    image: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    options?: {
        rotation?: number;
        flipX?: boolean;
        flipY?: boolean;
    }
) {
    const normalizedRotation = normalizeReferenceRotation(options?.rotation || 0);
    const targetSize = getReferenceRotatedSize(sourceWidth, sourceHeight, normalizedRotation);
    const flipX = options?.flipX ? -1 : 1;
    const flipY = options?.flipY ? -1 : 1;

    context.canvas.width = targetSize.width;
    context.canvas.height = targetSize.height;
    context.clearRect(0, 0, targetSize.width, targetSize.height);
    context.save();
    context.translate(targetSize.width / 2, targetSize.height / 2);
    context.rotate((normalizedRotation * Math.PI) / 180);
    context.scale(flipX, flipY);
    context.drawImage(image, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
    context.restore();

    return {
        width: targetSize.width,
        height: targetSize.height,
        rotation: normalizedRotation
    };
}
