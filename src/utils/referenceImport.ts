import { FloorReference } from '../store/useStore';

function loadImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Failed to load image'));
        image.src = src;
    });
}

function readImageAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
        reader.readAsDataURL(file);
    });
}

async function renderPdfPageAsDataUrl(file: File) {
    const [{ GlobalWorkerOptions, getDocument }, pdfWorker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    ]);

    GlobalWorkerOptions.workerSrc = pdfWorker.default;

    const pdf = await getDocument({ data: await file.arrayBuffer() }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    if (!context) {
        throw new Error('Canvas 2D context is not available');
    }

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
        canvas,
        canvasContext: context,
        viewport
    }).promise;

    return {
        src: canvas.toDataURL('image/png'),
        width: viewport.width,
        height: viewport.height
    };
}

export async function importReferenceFile(file: File): Promise<FloorReference> {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isImage = file.type.startsWith('image/');

    if (!isPdf && !isImage) {
        throw new Error('Unsupported file. Use an image or PDF.');
    }

    const imported = isPdf
        ? await renderPdfPageAsDataUrl(file)
        : await (async () => {
            const src = await readImageAsDataUrl(file);
            const image = await loadImage(src);
            return {
                src,
                width: image.naturalWidth,
                height: image.naturalHeight
            };
        })();

    return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        src: imported.src,
        kind: isPdf ? 'pdf' : 'image',
        width: imported.width,
        height: imported.height,
        opacity: 0.62,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        locked: true,
        rotation: 0,
        flipX: false,
        flipY: false
    };
}
