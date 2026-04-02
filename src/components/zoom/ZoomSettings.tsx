import { Slider } from "@/components/ui/slider";
import type { ZoomSegment } from "@/lib/ipc";

interface ZoomSettingsProps {
  segment: ZoomSegment | null;
  onSegmentChange: (segment: ZoomSegment) => void;
}

export function ZoomSettings({ segment, onSegmentChange }: ZoomSettingsProps) {
  if (!segment) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-[#6e6e6e]">
          Select a zoom segment on the timeline to edit its settings, or click the + Zoom button to create one.
        </span>
      </div>
    );
  }

  const update = (partial: Partial<ZoomSegment>) => {
    onSegmentChange({ ...segment, ...partial });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-[#6e6e6e] leading-[26px] tracking-[0.18px]">Zoom Segment</span>
        <span className="text-[10px] text-[#6e6e6e]">
          {segment.start_time.toFixed(1)}s – {segment.end_time.toFixed(1)}s
        </span>
      </div>

      <Slider
        label="Zoom Level"
        value={segment.zoom_level}
        min={1.2}
        max={5.0}
        step={0.1}
        displayValue={`${segment.zoom_level.toFixed(1)}×`}
        onChange={(v) => update({ zoom_level: v })}
      />

      {/* Follow Mouse toggle */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-[#6e6e6e]">Follow Mouse</span>
        <button
          className={`relative w-[34px] h-[18px] rounded-full transition-colors flex-shrink-0 ${
            segment.follow_mouse ? "bg-[#5b5bd6]" : "bg-white/10"
          }`}
          onClick={() => update({ follow_mouse: !segment.follow_mouse })}
        >
          <span
            className={`absolute top-[2px] left-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform ${
              segment.follow_mouse ? "translate-x-[16px]" : "translate-x-0"
            }`}
          />
        </button>
      </div>
      {segment.follow_mouse && (
        <Slider
          label="Follow Speed"
          value={segment.follow_speed}
          min={0.01}
          max={0.15}
          step={0.005}
          displayValue={
            segment.follow_speed <= 0.03
              ? "Very Slow"
              : segment.follow_speed <= 0.07
              ? "Slow"
              : "Moderate"
          }
          onChange={(v) => update({ follow_speed: v })}
        />
      )}
    </div>
  );
}
