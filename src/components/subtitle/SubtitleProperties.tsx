import { Slider } from "@/components/ui/slider";
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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Subtitle</span>
        <button
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          onClick={() => onStyleChange({ ...defaultSubtitleStyle })}
          title="Reset to defaults"
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>
      </div>

      {/* Text */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Text</label>
        <textarea
          className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm resize-none"
          rows={2}
          value={subtitle.text}
          onChange={(e) => onTextChange(e.target.value)}
        />
      </div>

      {/* Position */}
      <div className="flex flex-col gap-1.5 p-2 rounded border border-border">
        <label className="text-xs font-medium text-muted-foreground">Position</label>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px] text-muted-foreground">X</label>
            <input
              type="number"
              className="w-full bg-background border border-input rounded px-1.5 py-0.5 text-xs tabular-nums"
              value={Math.round(s.x * 100)}
              min={0} max={100}
              onChange={(e) => update({ x: parseInt(e.target.value) / 100 })}
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px] text-muted-foreground">Y</label>
            <input
              type="number"
              className="w-full bg-background border border-input rounded px-1.5 py-0.5 text-xs tabular-nums"
              value={Math.round(s.y * 100)}
              min={0} max={100}
              onChange={(e) => update({ y: parseInt(e.target.value) / 100 })}
            />
          </div>
        </div>
      </div>

      {/* Transform */}
      <div className="flex flex-col gap-1.5 p-2 rounded border border-border">
        <label className="text-xs font-medium text-muted-foreground">Transform</label>
        <Slider label="Scale" value={s.scale} min={0.1} max={5} step={0.05}
          displayValue={`${s.scale.toFixed(2)}×`}
          onChange={(v) => update({ scale: v })} />
        <Slider label="Rotation" value={s.rotation} min={-180} max={180} step={1}
          displayValue={`${Math.round(s.rotation)}°`}
          onChange={(v) => update({ rotation: v })} />
      </div>

      {/* Font */}
      <div className="flex flex-col gap-1.5 p-2 rounded border border-border">
        <label className="text-xs font-medium text-muted-foreground">Font</label>
        <Slider label="Size" value={s.fontSize} min={12} max={200} step={1}
          displayValue={`${s.fontSize}px`}
          onChange={(v) => update({ fontSize: v })} />
        <Slider label="Letter Spacing" value={s.letterSpacing} min={-5} max={20} step={0.5}
          displayValue={`${s.letterSpacing}px`}
          onChange={(v) => update({ letterSpacing: v })} />
        <Slider label="Line Height" value={s.lineHeight} min={0.8} max={3} step={0.05}
          displayValue={s.lineHeight.toFixed(2)}
          onChange={(v) => update({ lineHeight: v })} />
      </div>

      {/* Colors */}
      <div className="flex flex-col gap-1.5 p-2 rounded border border-border">
        <label className="text-xs font-medium text-muted-foreground">Colors</label>
        <ColorRow label="Font Color" value={s.fontColor}
          onChange={(v) => update({ fontColor: v })} />
        <ColorRow label="Stroke" value={s.strokeColor}
          onChange={(v) => update({ strokeColor: v })} />
        <Slider label="Stroke Width" value={s.strokeWidth} min={0} max={10} step={0.5}
          displayValue={`${s.strokeWidth}px`}
          onChange={(v) => update({ strokeWidth: v })} />
        <ColorRow label="Background" value={s.bgColor === "transparent" ? "#000000" : s.bgColor}
          onChange={(v) => update({ bgColor: v })} />
      </div>

      {/* Appearance */}
      <div className="flex flex-col gap-1.5 p-2 rounded border border-border">
        <label className="text-xs font-medium text-muted-foreground">Appearance</label>
        <Slider label="Opacity" value={s.opacity} min={0} max={1} step={0.01}
          displayValue={`${Math.round(s.opacity * 100)}%`}
          onChange={(v) => update({ opacity: v })} />
        <div className="flex flex-col gap-0.5">
          <label className="text-xs text-muted-foreground">Blend Mode</label>
          <select
            className="w-full bg-background border border-input rounded px-1.5 py-1 text-xs"
            value={s.blendMode}
            onChange={(e) => update({ blendMode: e.target.value })}
          >
            {BLEND_MODES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function ColorRow({
  label, value, onChange,
}: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <label className="text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          className="w-6 h-6 rounded border border-input cursor-pointer bg-transparent"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          type="text"
          className="w-16 bg-background border border-input rounded px-1 py-0.5 text-[10px] tabular-nums"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
