import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { PreviewScene, type View } from '../scene';
import type { Model } from '../protocol';

export interface ViewerHandle {
  fit(view?: View): void;
}

interface ViewerProps {
  model: Model | null;
  hidden: Set<string>;
  bed: [number, number] | null;
}

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(function Viewer({ model, hidden, bed }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const scene = useRef<PreviewScene | null>(null);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  useEffect(() => {
    const s = new PreviewScene(container.current!);
    scene.current = s;
    return () => {
      s.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => scene.current?.setBed(bed), [bed?.[0], bed?.[1]]);
  useEffect(() => scene.current?.setModel(model, hiddenRef.current), [model]);
  useEffect(() => scene.current?.setHidden(hidden), [hidden]);

  useImperativeHandle(ref, () => ({ fit: (view) => scene.current?.fit(view) }), []);

  return <div ref={container} className="absolute inset-0" />;
});
