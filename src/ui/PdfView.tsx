/**
 * Advanced PDF Viewer with Intelligent Page Navigation.
 *
 * Supports:
 * - Direct jumping to specific pages (voice: "open the 8th page", "go to page 5")
 * - First page ("start from the beginning") and last page ("jump to the end")
 * - Relative navigation (swipe left = next, swipe right = prev, "next page", "go back 2 pages")
 * - Document total page count detection and boundary validation
 * - Dynamic zoom and smooth target scrolling
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';

export function PdfView({ doc, zoom }: { doc: any; zoom: number }) {
  const host = useRef<HTMLDivElement>(null);
  const totalPages = doc?.numPages || 1;
  const currentPage = useStore(st => st.pdfCurrentPage);
  const pdfNav = useStore(st => st.pdfNav);
  const pdfSetPage = useStore(st => st.pdfSetPage);
  const [jumpInput, setJumpInput] = useState('');

  // Register total pages with the store immediately
  useEffect(() => {
    if (doc?.numPages) {
      useStore.getState().pdfSetTotalPages(doc.numPages);
    }
  }, [doc]);

  // Jump to page event listener
  useEffect(() => {
    const onJump = (e: Event) => {
      const pageNum = (e as CustomEvent<{ page: number }>).detail?.page;
      if (pageNum) {
        scrollToPage(pageNum);
      }
    };
    window.addEventListener('nexus:pdf-jump', onJump);
    return () => window.removeEventListener('nexus:pdf-jump', onJump);
  }, []);

  // Scroll to target page canvas
  const scrollToPage = (pageNum: number) => {
    const el = host.current;
    if (!el) return;
    const canvas = el.querySelector(`[data-page-num="${pageNum}"]`) as HTMLElement | null;
    if (canvas) {
      canvas.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Render canvases for each page
  useEffect(() => {
    let cancelled = false;
    const tasks: any[] = [];

    const timer = setTimeout(async () => {
      const el = host.current;
      if (!el) return;
      el.replaceChildren();

      const width = Math.max(300, el.clientWidth - 16);
      const dpr = Math.min(2, window.devicePixelRatio || 1);

      for (let i = 1; i <= Math.min(doc.numPages, 60); i++) {
        if (cancelled) return;
        const page = await doc.getPage(i);
        const fit = width / page.getViewport({ scale: 1 }).width;
        const vp = page.getViewport({ scale: fit * zoom * dpr });

        const wrapper = document.createElement('div');
        wrapper.className = 'relative mb-6 flex flex-col items-center';
        wrapper.setAttribute('data-page-num', String(i));

        const badge = document.createElement('div');
        badge.className = 'mb-1 rounded-full bg-white/10 px-3 py-0.5 text-xs text-white/60';
        badge.textContent = `Page ${i} of ${totalPages}`;
        wrapper.appendChild(badge);

        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        canvas.style.width = `${vp.width / dpr}px`;
        canvas.style.height = `${vp.height / dpr}px`;
        canvas.className = 'rounded-xl bg-white shadow-2xl';
        wrapper.appendChild(canvas);

        el.appendChild(wrapper);

        const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp });
        tasks.push(task);
        try {
          await task.promise;
        } catch {
          /* cancelled */
        }
      }

      // After render, scroll to the current page if not page 1
      if (currentPage > 1) {
        scrollToPage(currentPage);
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      tasks.forEach(t => t.cancel?.());
    };
  }, [doc, zoom]);

  const handleJumpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseInt(jumpInput, 10);
    if (!isNaN(p)) {
      pdfSetPage(p);
      setJumpInput('');
    }
  };

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      {/* PDF Navigation Top Toolbar */}
      <div className="sticky top-0 z-30 flex items-center gap-2 rounded-2xl border border-white/20 bg-slate-900/90 px-4 py-2 text-sm shadow-xl backdrop-blur-md">
        <button
          onClick={() => pdfNav('first')}
          title="First page (Voice: 'go to starting page')"
          className="rounded-lg px-2.5 py-1 hover:bg-white/15 text-white/80 transition"
        >
          ⏮ First
        </button>
        <button
          onClick={() => pdfNav('prev')}
          title="Previous page (Swipe left-to-right / Voice: 'previous page')"
          className="rounded-lg px-2.5 py-1 hover:bg-white/15 text-white/80 transition"
        >
          ◀ Prev
        </button>

        <span className="px-2 font-medium text-cyan-200">
          Page {currentPage} / {totalPages}
        </span>

        <button
          onClick={() => pdfNav('next')}
          title="Next page (Swipe right-to-left / Voice: 'next page')"
          className="rounded-lg px-2.5 py-1 hover:bg-white/15 text-white/80 transition"
        >
          Next ▶
        </button>
        <button
          onClick={() => pdfNav('last')}
          title="Last page (Voice: 'jump to the end')"
          className="rounded-lg px-2.5 py-1 hover:bg-white/15 text-white/80 transition"
        >
          Last ⏭
        </button>

        {/* Quick jump input */}
        <form onSubmit={handleJumpSubmit} className="flex items-center gap-1 ml-2 border-l border-white/15 pl-3">
          <input
            type="number"
            min="1"
            max={totalPages}
            value={jumpInput}
            onChange={e => setJumpInput(e.target.value)}
            placeholder="#"
            className="w-12 rounded-lg border border-white/20 bg-black/40 px-2 py-0.5 text-center text-xs text-white outline-none focus:border-cyan-300"
          />
          <button type="submit" className="rounded-lg bg-white/15 px-2 py-0.5 text-xs hover:bg-white/25">
            Go
          </button>
        </form>
      </div>

      {/* Pages Container */}
      <div ref={host} className="w-full" />
    </div>
  );
}
