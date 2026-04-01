import { Slider } from "@/components/ui/slider";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import type { Subtitle, SubtitleStyle } from "@/lib/ipc";
import { defaultSubtitleStyle } from "@/lib/ipc";
import { RotateCcw } from "lucide-react";

interface SubtitlePropertiesProps {
  subtitle: Subtitle;
  onTextChange: (text: string) => void;
  onStyleChange: (style: SubtitleStyle) => void;
}

const BLEND_MODES = [
  "source-over", "multiply", "screen", "overlay", "darken",
  "lighten", "color-dodge", "color-burn", "hard-light",
  "soft-light", "difference", "exclusion",
];

export function SubtitleProperties({
  subtitle,
  onTextChange,
  onStyleChange,
}: SubtitlePropertiesProps) {
  const s: SubtitleStyle = { ...defaultSubtitleStyle, ...subtitle.style };

  const update = (partial: Partial<SubtitleStyle>) => {
    onStyleChange({ ...s, ...partial });
  };

  return (
    <div className="flex flex-col gap-1.5">
      {/* Content */}
      <PropSection label="Content">
        <textarea
          className="w-full bg-white/[0.06] rounded-[10px] px-2 py-1.5 text-xs text-white resize-none border-none outline-none placeholder:text-[#6e6e6e]"
          rows={2}
          value={subtitle.text}
          onChange={(e) => onTextChange(e.target.value)}
        />
      </PropSection>

      {/* Position */}
      <PropSection label="Position">
        <div className="flex gap-2">
          <PropInput label="X" value={Math.round(s.x * 100)}
            onChange={(v) => update({ x: v / 100 })} />
          <PropInput label="Y" value={Math.round(s.y * 100)}
            onChange={(v) => update({ y: v / 100 })} />
        </div>
      </PropSection>

      {/* Scale */}
      <PropSection label="Scale">
        <PropInput label={<ScaleIcon />} value={s.scale} step={0.05} min={0.1} max={5}
          onChange={(v) => update({ scale: v })} />
      </PropSection>

      {/* Rotation */}
      <PropSection label="Rotation">
        <PropInput label={<RotationIcon />} value={Math.round(s.rotation)} min={-180} max={180}
          onChange={(v) => update({ rotation: v })} />
      </PropSection>

      {/* Font */}
      <PropSection label="Font">
        <PropInput label="Sz" value={s.fontSize} min={12} max={200}
          onChange={(v) => update({ fontSize: v })} />
        <div className="flex gap-2 mt-1.5">
          <PropInput label="Ls" value={s.letterSpacing} step={0.5} min={-5} max={20}
            onChange={(v) => update({ letterSpacing: v })} />
          <PropInput label="Lh" value={Number(s.lineHeight.toFixed(2))} step={0.05} min={0.8} max={3}
            onChange={(v) => update({ lineHeight: v })} />
        </div>
      </PropSection>

      {/* Colors */}
      <PropSection label="Colors">
        <ColorRow label="Font" value={s.fontColor}
          onChange={(v) => update({ fontColor: v })} />
        <ColorRow label="Stroke" value={s.strokeColor}
          onChange={(v) => update({ strokeColor: v })} />
        <Slider label="Stroke W" value={s.strokeWidth} min={0} max={10} step={0.5}
          displayValue={`${s.strokeWidth}px`}
          onChange={(v) => update({ strokeWidth: v })} />
        <ColorRow label="BG" value={s.bgColor === "transparent" ? "#000000" : s.bgColor}
          onChange={(v) => update({ bgColor: v })} />
      </PropSection>

      {/* Appearance */}
      <PropSection label="Appearance">
        <Slider label="Opacity" value={s.opacity} min={0} max={1} step={0.01}
          displayValue={`${Math.round(s.opacity * 100)}%`}
          onChange={(v) => update({ opacity: v })} />
        <div className="flex flex-col gap-0.5">
          <label className="text-[10px] text-[#6e6e6e]">Blend Mode</label>
          <Select value={s.blendMode} onValueChange={(v) => update({ blendMode: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BLEND_MODES.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PropSection>

      {/* Reset */}
      <button
        className="flex items-center justify-center gap-1 text-[10px] text-[#6e6e6e] hover:text-white/70 transition-colors mt-1"
        onClick={() => onStyleChange({ ...defaultSubtitleStyle })}
        title="Reset to defaults"
      >
        <RotateCcw className="size-3" />
        Reset
      </button>
    </div>
  );
}

function PropSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-[#6e6e6e] leading-[26px] tracking-[0.18px]">{label}</span>
      {children}
    </div>
  );
}

function PropInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: React.ReactNode;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="flex-1 flex items-center gap-1.5 bg-white/[0.06] rounded-[10px] px-2 py-0.5">
      <span className="text-xs text-[#6e6e6e] shrink-0">{label}</span>
      <input
        type="number"
        className="w-full bg-transparent text-xs text-white border-none outline-none tabular-nums"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </div>
  );
}

function ColorRow({
  label, value, onChange,
}: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <label className="text-[10px] text-[#6e6e6e]">{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          className="w-5 h-5 rounded border border-white/[0.08] cursor-pointer bg-transparent"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          type="text"
          className="w-14 bg-white/[0.06] rounded-[6px] px-1 py-0.5 text-[10px] text-white tabular-nums border-none outline-none"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

function ScaleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="size-4 text-[#6e6e6e]">
      <path d="M2 6V2h4M14 10v4h-4M2 2l5 5M14 14l-5-5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function RotationIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="size-4 text-[#6e6e6e]">
      <path d="M12 8a4 4 0 1 1-1.2-2.86" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M12 2v3.14h-3.14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
