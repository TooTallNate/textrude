import { useEffect, useState, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '../lib/utils';

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-b border-zinc-800 px-4 py-4">
      <div className="mb-3 flex h-6 items-center justify-between">
        <h2 className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">{title}</h2>
        {right}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <label className="shrink-0 text-sm text-zinc-300" title={hint}>
        {label}
      </label>
      <div className="flex min-w-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none',
        checked ? 'bg-sky-500' : 'bg-zinc-700',
      )}
    >
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  );
}

const inputClass =
  'h-8 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none';

/** A number field that only reports valid numbers (null when cleared, if `nullable`). */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 0.1,
  placeholder,
  nullable = false,
  unit,
  className,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  nullable?: boolean;
  unit?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  useEffect(() => {
    if (value == null ? draft !== '' : Number(draft) !== value) setDraft(value == null ? '' : String(value));
  }, [value]);
  return (
    <div className="relative">
      <input
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          if (e.target.value === '') {
            if (nullable) onChange(null);
            return;
          }
          const n = Number(e.target.value);
          if (Number.isFinite(n) && (min == null || n >= min) && (max == null || n <= max)) onChange(n);
        }}
        onBlur={() => setDraft(value == null ? '' : String(value))}
        className={cn(inputClass, 'w-20 tabular-nums', unit && 'pr-8', className)}
      />
      {unit && <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-zinc-500">{unit}</span>}
    </div>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 0.1,
  unit,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}) {
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-28 accent-sky-500"
      />
      <NumberInput value={value} onChange={(v) => v != null && onChange(v)} min={min} step={step} unit={unit} />
    </>
  );
}

const HEX = /^#[0-9a-f]{6}$/i;

export function ColorInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className={cn('flex items-center gap-2', disabled && 'pointer-events-none opacity-40')}>
      <label className="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-zinc-700" style={{ background: value }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
      <input
        value={draft}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value.trim();
          setDraft(v);
          const hex = v.startsWith('#') ? v : `#${v}`;
          if (HEX.test(hex)) onChange(hex.toLowerCase());
        }}
        onBlur={() => setDraft(value)}
        className={cn(inputClass, 'w-22 font-mono text-xs')}
      />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-zinc-700 bg-zinc-900 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-6.5 min-w-8 cursor-pointer items-center justify-center rounded px-2 text-xs transition-colors',
            value === o.value ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ToggleButton({
  pressed,
  onChange,
  title,
  children,
}: {
  pressed: boolean;
  onChange: (v: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={cn(
        'flex size-8 cursor-pointer items-center justify-center rounded-md border transition-colors',
        pressed ? 'border-sky-500 bg-sky-500/15 text-sky-300' : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200',
      )}
    >
      {children}
    </button>
  );
}

export function Select({ value, onChange, children, className }: { value: string; onChange: (v: string) => void; children: ReactNode; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cn(inputClass, 'cursor-pointer pr-7', className)}>
      {children}
    </select>
  );
}

/** An editable list of colors (e.g. filament slots). */
export function ColorList({ colors, onChange, numbered }: { colors: string[]; onChange: (v: string[]) => void; numbered?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {colors.map((c, i) => (
        <div key={i} className="group relative">
          <label
            className="relative flex size-8 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-zinc-700 text-[10px] font-semibold"
            style={{ background: c, color: luminance(c) > 0.5 ? '#000' : '#fff' }}
            title={c}
          >
            {numbered ? i + 1 : null}
            <input
              type="color"
              value={c}
              onChange={(e) => onChange(colors.map((x, j) => (j === i ? e.target.value : x)))}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
          {colors.length > 1 && (
            <button
              type="button"
              aria-label="Remove color"
              onClick={() => onChange(colors.filter((_, j) => j !== i))}
              className="absolute -top-1.5 -right-1.5 hidden size-4 cursor-pointer items-center justify-center rounded-full bg-zinc-600 text-white group-hover:flex hover:bg-red-500"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        aria-label="Add color"
        onClick={() => onChange([...colors, colors[colors.length - 1] ?? '#ffffff'])}
        className="flex size-8 cursor-pointer items-center justify-center rounded-md border border-dashed border-zinc-600 text-zinc-400 hover:border-zinc-400 hover:text-zinc-200"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

export function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
