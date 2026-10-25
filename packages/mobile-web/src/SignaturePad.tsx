import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

/**
 * Finger, mouse, and pen signature pad on a `<canvas>`.
 *
 * What makes it work on phones:
 * - Pointer Events handle mouse, touch, and pen with one set of handlers.
 * - `touch-action: none` stops the page from scrolling or zooming while signing.
 * - `setPointerCapture` keeps the stroke going when the finger leaves the canvas.
 * - The bitmap is sized by `devicePixelRatio`, so lines stay sharp on retina screens.
 * - Mobile browsers fire `resize` when the address bar hides. Setting `canvas.width`
 *   clears the drawing, so the pad only resizes when its size really changes,
 *   and copies the old drawing back when it does.
 */

export interface SignaturePadHandle {
  clear: () => void;
  isEmpty: () => boolean;
  /** PNG by default. Resolves `null` when the pad is empty. */
  toBlob: (type?: string, quality?: number) => Promise<Blob | null>;
  /** PNG data URL. Returns `null` when the pad is empty. */
  toDataURL: (type?: string, quality?: number) => string | null;
}

export interface SignaturePadProps {
  /** CSS height of the pad. Default `200`. Width follows the container. */
  height?: number;
  /** Stroke width in CSS pixels. Default `2.5`. */
  lineWidth?: number;
  /** Stroke color. Default: the element's CSS `color`. */
  color?: string;
  /** Called with `true` after clear and `false` after the first stroke. */
  onEmptyChange?: (empty: boolean) => void;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
}

export const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(function SignaturePad(
  { height = 200, lineWidth = 2.5, color, onEmptyChange, className, style, 'aria-label': ariaLabel = 'Signature' },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Not rendered, so refs instead of state: no re-render on every pointer move.
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const empty = useRef(true);
  const onEmptyChangeRef = useRef(onEmptyChange);
  onEmptyChangeRef.current = onEmptyChange;

  const setEmpty = useCallback((value: boolean) => {
    if (empty.current === value) return;
    empty.current = value;
    onEmptyChangeRef.current?.(value);
  }, []);

  const applyPen = useCallback(
    (context: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
      context.lineWidth = lineWidth;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = color ?? getComputedStyle(canvas).color;
      context.fillStyle = context.strokeStyle;
    },
    [color, lineWidth],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const fit = () => {
      const rect = canvas.getBoundingClientRect(); // read layout once, then write
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(rect.width * dpr);
      const heightPx = Math.round(rect.height * dpr);
      const context = canvas.getContext('2d');
      if (!context) return;
      if (canvas.width === width && canvas.height === heightPx) {
        applyPen(context, canvas);
        return;
      }

      const backup = document.createElement('canvas');
      backup.width = canvas.width;
      backup.height = canvas.height;
      if (backup.width && backup.height) backup.getContext('2d')?.drawImage(canvas, 0, 0);

      canvas.width = width; // this line clears the bitmap
      canvas.height = heightPx;
      if (backup.width && backup.height) context.drawImage(backup, 0, 0, width, heightPx);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      applyPen(context, canvas);
    };

    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [applyPen]);

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.restore();
    setEmpty(true);
  }, [setEmpty]);

  useImperativeHandle(
    ref,
    () => ({
      clear,
      isEmpty: () => empty.current,
      toDataURL: (type = 'image/png', quality) =>
        empty.current || !canvasRef.current ? null : canvasRef.current.toDataURL(type, quality),
      toBlob: (type = 'image/png', quality) =>
        new Promise((resolve) => {
          if (empty.current || !canvasRef.current) {
            resolve(null);
            return;
          }
          canvasRef.current.toBlob(resolve, type, quality);
        }),
    }),
    [clear],
  );

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-label={ariaLabel}
      role="img"
      style={{
        display: 'block',
        width: '100%',
        height,
        touchAction: 'none',
        overscrollBehavior: 'contain',
        ...style,
      }}
      onPointerDown={(event) => {
        const context = event.currentTarget.getContext('2d');
        if (!context) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drawing.current = true;
        last.current = point(event);
        // A tap leaves a dot.
        context.beginPath();
        context.arc(last.current.x, last.current.y, lineWidth / 2, 0, Math.PI * 2);
        context.fill();
        setEmpty(false);
      }}
      onPointerMove={(event) => {
        if (!drawing.current || !last.current) return;
        const context = event.currentTarget.getContext('2d');
        if (!context) return;
        const next = point(event);
        context.beginPath();
        context.moveTo(last.current.x, last.current.y);
        context.lineTo(next.x, next.y);
        context.stroke();
        last.current = next;
      }}
      onPointerUp={() => {
        drawing.current = false;
        last.current = null;
      }}
      onPointerCancel={() => {
        drawing.current = false;
        last.current = null;
      }}
    />
  );
});
