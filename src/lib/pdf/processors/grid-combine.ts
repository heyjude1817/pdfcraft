/**
 * PDF Grid Combine Processor
 * 
 * Combines multiple PDF files into a grid layout on single pages.
 * Unlike N-Up which arranges pages from ONE PDF, this tool arranges
 * pages from MULTIPLE PDFs side by side.
 */

import type {
    ProcessInput,
    ProcessOutput,
    ProgressCallback,
} from '@/types/pdf';
import { PDFErrorCode } from '@/types/pdf';
import { BasePDFProcessor } from '../processor';
import { loadPdfLib } from '../loader';

/**
 * Grid Combine options
 */
export interface GridCombineOptions {
    /** Grid layout: columns x rows */
    gridLayout: '2x1' | '1x2' | '2x2' | '3x3' | '2x3' | '3x2' | '4x4';
    /** Output page size */
    pageSize: 'A4' | 'Letter' | 'Legal' | 'A3';
    /** Page orientation */
    orientation: 'portrait' | 'landscape';
    /** Add margins */
    useMargins: boolean;
    /** Add border around each PDF */
    addBorder: boolean;
    /** Border color (hex) */
    borderColor: string;
    /** Include spacing between items */
    spacing: number;
    /** Fill mode: how to handle empty cells when files < grid cells */
    fillMode: 'leave-empty' | 'repeat' | 'stretch-last';
    /** Page mode: use only first page or all pages from each PDF */
    pageMode: 'first-page-only' | 'all-pages';
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: GridCombineOptions = {
    gridLayout: '2x2',
    pageSize: 'A4',
    orientation: 'landscape',
    useMargins: true,
    addBorder: true,
    borderColor: '#CCCCCC',
    spacing: 10,
    fillMode: 'leave-empty',
    pageMode: 'first-page-only',
};

/**
 * Page sizes in points
 */
const PAGE_SIZES: Record<string, [number, number]> = {
    A4: [595.28, 841.89],
    Letter: [612, 792],
    Legal: [612, 1008],
    A3: [841.89, 1190.55],
};

/**
 * Parse grid layout string to [cols, rows]
 */
function parseGridLayout(layout: string): [number, number] {
    const match = layout.match(/(\d+)x(\d+)/);
    if (match) {
        return [parseInt(match[1], 10), parseInt(match[2], 10)];
    }
    return [2, 2]; // Default
}

/**
 * PDF Grid Combine Processor
 */
export class GridCombineProcessor extends BasePDFProcessor {
    /**
     * Process multiple PDF files and combine them in a grid layout
     */
    async process(
        input: ProcessInput,
        onProgress?: ProgressCallback
    ): Promise<ProcessOutput> {
        this.reset();
        this.onProgress = onProgress;

        const { files, options } = input;
        const combineOptions: GridCombineOptions = {
            ...DEFAULT_OPTIONS,
            ...(options as Partial<GridCombineOptions>),
        };

        // Validate we have at least 2 files
        if (files.length < 2) {
            return this.createErrorOutput(
                PDFErrorCode.INVALID_OPTIONS,
                'At least 2 PDF files are required for grid combine.',
                `Received ${files.length} file(s).`
            );
        }

        try {
            this.updateProgress(5, 'Loading PDF library...');

            const pdfLib = await loadPdfLib();

            if (this.checkCancelled()) {
                return this.createErrorOutput(
                    PDFErrorCode.PROCESSING_CANCELLED,
                    'Processing was cancelled.'
                );
            }

            this.updateProgress(10, 'Loading source PDFs...');

            // Get grid dimensions
            const [cols, rows] = parseGridLayout(combineOptions.gridLayout);
            const cellsPerPage = cols * rows;

            // Get page size
            let [pageWidth, pageHeight] = PAGE_SIZES[combineOptions.pageSize];

            // Apply orientation
            if (combineOptions.orientation === 'landscape' && pageWidth < pageHeight) {
                [pageWidth, pageHeight] = [pageHeight, pageWidth];
            } else if (combineOptions.orientation === 'portrait' && pageWidth > pageHeight) {
                [pageWidth, pageHeight] = [pageHeight, pageWidth];
            }

            // Calculate margins and spacing
            const margin = combineOptions.useMargins ? 36 : 0;
            const spacing = combineOptions.spacing;

            const usableWidth = pageWidth - margin * 2;
            const usableHeight = pageHeight - margin * 2;

            const cellWidth = (usableWidth - spacing * (cols - 1)) / cols;
            const cellHeight = (usableHeight - spacing * (rows - 1)) / rows;

            // Load all source PDFs
            const sourceDocs: { doc: unknown; name: string }[] = [];
            const progressPerFile = 30 / files.length;

            for (let i = 0; i < files.length; i++) {
                if (this.checkCancelled()) {
                    return this.createErrorOutput(
                        PDFErrorCode.PROCESSING_CANCELLED,
                        'Processing was cancelled.'
                    );
                }

                const file = files[i];
                this.updateProgress(
                    10 + i * progressPerFile,
                    `Loading ${file.name}...`
                );

                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const doc = await pdfLib.PDFDocument.load(arrayBuffer, {
                        ignoreEncryption: true,
                    });
                    sourceDocs.push({ doc, name: file.name });
                } catch (error) {
                    return this.createErrorOutput(
                        PDFErrorCode.PROCESSING_FAILED,
                        `Failed to load "${file.name}".`,
                        error instanceof Error ? error.message : 'Unknown error'
                    );
                }
            }

            this.updateProgress(40, 'Creating grid layout...');

            // Create new PDF
            const newPdf = await pdfLib.PDFDocument.create();

            // Parse border color
            const borderRgb = hexToRgb(combineOptions.borderColor);

            // Get pages from each PDF based on pageMode
            const sourcePages: { page: unknown; name: string; pageNum: number }[] = [];
            for (const { doc, name } of sourceDocs) {
                const pdfDoc = doc as ReturnType<typeof pdfLib.PDFDocument.load> extends Promise<infer T> ? T : never;
                const pages = (pdfDoc as { getPages: () => unknown[] }).getPages();

                if (combineOptions.pageMode === 'all-pages') {
                    // Include all pages from each PDF
                    for (let i = 0; i < pages.length; i++) {
                        sourcePages.push({ page: pages[i], name, pageNum: i + 1 });
                    }
                } else {
                    // Only first page
                    if (pages.length > 0) {
                        sourcePages.push({ page: pages[0], name, pageNum: 1 });
                    }
                }
            }

            // Apply fill mode if needed
            let pagesToProcess = [...sourcePages];
            if (sourcePages.length < cellsPerPage) {
                if (combineOptions.fillMode === 'repeat') {
                    // Repeat pages to fill the grid
                    while (pagesToProcess.length < cellsPerPage) {
                        const idx = pagesToProcess.length % sourcePages.length;
                        pagesToProcess.push({ ...sourcePages[idx] });
                    }
                } else if (combineOptions.fillMode === 'stretch-last') {
                    // Repeat the last page to fill remaining cells
                    const lastPage = sourcePages[sourcePages.length - 1];
                    while (pagesToProcess.length < cellsPerPage) {
                        pagesToProcess.push({ ...lastPage });
                    }
                }
                // 'leave-empty' - do nothing, keep original pages
            }

            // Pre-embed all unique source pages at once to avoid duplicate font embedding
            // This is crucial for CJK PDFs where fonts can be very large
            this.updateProgress(45, 'Embedding pages...');

            // Create a map of unique pages to embed (using page object as key)
            const uniquePages: unknown[] = [];
            const pageToIndex = new Map<unknown, number>();

            for (const { page } of sourcePages) {
                if (!pageToIndex.has(page)) {
                    pageToIndex.set(page, uniquePages.length);
                    uniquePages.push(page);
                }
            }

            // Embed all unique pages at once
            const embeddedPagesArray = await newPdf.embedPages(
                uniquePages as Parameters<typeof newPdf.embedPages>[0]
            );

            // Create a lookup from original page to embedded page
            const embeddedPageMap = new Map<unknown, typeof embeddedPagesArray[0]>();
            for (let i = 0; i < uniquePages.length; i++) {
                embeddedPageMap.set(uniquePages[i], embeddedPagesArray[i]);
            }

            // Calculate how many output pages we need
            const totalOutputPages = Math.ceil(pagesToProcess.length / cellsPerPage);
            const progressPerPage = 40 / totalOutputPages;

            for (let outputPageNum = 0; outputPageNum < totalOutputPages; outputPageNum++) {
                if (this.checkCancelled()) {
                    return this.createErrorOutput(
                        PDFErrorCode.PROCESSING_CANCELLED,
                        'Processing was cancelled.'
                    );
                }

                this.updateProgress(
                    50 + outputPageNum * progressPerPage,
                    `Creating page ${outputPageNum + 1} of ${totalOutputPages}...`
                );

                const outputPage = newPdf.addPage([pageWidth, pageHeight]);

                // Get the subset of source pages for this output page
                const startIdx = outputPageNum * cellsPerPage;
                const endIdx = Math.min(startIdx + cellsPerPage, pagesToProcess.length);
                const pageSubset = pagesToProcess.slice(startIdx, endIdx);

                for (let cellIdx = 0; cellIdx < pageSubset.length; cellIdx++) {
                    const { page: sourcePage } = pageSubset[cellIdx];

                    // Use pre-embedded page from map
                    const embeddedPage = embeddedPageMap.get(sourcePage)!;

                    // Calculate scale to fit in cell
                    const scale = Math.min(
                        cellWidth / embeddedPage.width,
                        cellHeight / embeddedPage.height
                    );
                    const scaledWidth = embeddedPage.width * scale;
                    const scaledHeight = embeddedPage.height * scale;

                    // Calculate position in grid
                    // PDF坐标系原点在左下角，Y轴向上
                    const col = cellIdx % cols;
                    const row = Math.floor(cellIdx / cols);
                    const cellX = margin + col * (cellWidth + spacing);
                    // 修复Y坐标计算：从顶部开始排列，第一行在最上面
                    const cellY = pageHeight - margin - cellHeight - row * (cellHeight + spacing);

                    // Center within cell
                    const x = cellX + (cellWidth - scaledWidth) / 2;
                    const y = cellY + (cellHeight - scaledHeight) / 2;

                    outputPage.drawPage(embeddedPage, {
                        x,
                        y,
                        width: scaledWidth,
                        height: scaledHeight,
                    });

                    // Draw border if enabled
                    if (combineOptions.addBorder) {
                        outputPage.drawRectangle({
                            x,
                            y,
                            width: scaledWidth,
                            height: scaledHeight,
                            borderColor: pdfLib.rgb(borderRgb.r, borderRgb.g, borderRgb.b),
                            borderWidth: 0.5,
                        });
                    }
                }
            }

            this.updateProgress(90, 'Saving PDF...');

            // Save the new PDF with object streams enabled for better compression
            const pdfBytes = await newPdf.save({
                useObjectStreams: true,
            });
            const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });

            this.updateProgress(100, 'Complete!');

            // Generate output filename
            const outputFilename = `combined_${cols}x${rows}_grid.pdf`;

            return this.createSuccessOutput(blob, outputFilename, {
                sourceFileCount: files.length,
                totalSourcePages: pagesToProcess.length,
                gridLayout: combineOptions.gridLayout,
                outputPageCount: totalOutputPages,
                pageMode: combineOptions.pageMode,
                fillMode: combineOptions.fillMode,
            });

        } catch (error) {
            return this.createErrorOutput(
                PDFErrorCode.PROCESSING_FAILED,
                'Failed to create grid combined PDF.',
                error instanceof Error ? error.message : 'Unknown error'
            );
        }
    }

    /**
     * Get accepted file types
     */
    protected getAcceptedTypes(): string[] {
        return ['application/pdf'];
    }
}

/**
 * Convert hex color to RGB (0-1 range)
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
        return {
            r: parseInt(result[1], 16) / 255,
            g: parseInt(result[2], 16) / 255,
            b: parseInt(result[3], 16) / 255,
        };
    }
    return { r: 0.8, g: 0.8, b: 0.8 }; // Default light gray
}

/**
 * Create a new instance of the processor
 */
export function createGridCombineProcessor(): GridCombineProcessor {
    return new GridCombineProcessor();
}

/**
 * Combine multiple PDFs in a grid layout (convenience function)
 */
export async function createGridCombinePDF(
    files: File[],
    options: Partial<GridCombineOptions>,
    onProgress?: ProgressCallback
): Promise<ProcessOutput> {
    const processor = createGridCombineProcessor();
    return processor.process(
        {
            files,
            options: options as Record<string, unknown>,
        },
        onProgress
    );
}
