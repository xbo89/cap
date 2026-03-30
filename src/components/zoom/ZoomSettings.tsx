import { Slider } from "@/components/ui/slider";
import type { ZoomConfig } from "@/lib/zoom";

interface ZoomSettingsProps {
  config: ZoomConfig;
  enabled: boolean;
  onConfigChange: (config: ZoomConfig) => void;
  onEnabledChange: (enabled: boolean) => void;
}

export function ZoomSettings({
  config,
  enabled,
  onConfigChange,
  onEnabledChange,
}: ZoomSettingsProps) {
  const update = (partial: Partial<ZoomConfig>) => {
    onConfigChange({ ...config, ...partial });
  };

  return (
    <div className="flex flex-col gap-4 p-4 rounded-lg border border-border bg-card">
      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Zoom Effect</span>
        <button
          onClick={() => onEnabledChange(!enabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            enabled ? "bg-primary" : "bg-secondary"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background transition-transform ${
              enabled ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {enabled && (
        <>
          <Slider
            label="Zoom Level"
            value={config.zoomLevel}
            min={1.2}
            max={5.0}
            step={0.1}
            displayValue={`${config.zoomLevel.toFixed(1)}×`}
            onChange={(v) => update({ zoomLevel: v })}
          />

          <Slider
            label="Follow Speed"
            value={config.followSpeed}
            min={0.02}
            max={0.5}
            step={0.01}
            displayValue={
              config.followSpeed < 0.1
                ? "Cinematic"
                : config.followSpeed < 0.25
                ? "Smooth"
                : "Snappy"
            }
            onChange={(v) => update({ followSpeed: v })}
          />

          <Slider
            label="Edge Padding"
            value={config.padding}
            min={0}
            max={300}
            step={10}
            displayValue={`${config.padding}px`}
            onChange={(v) => update({ padding: v })}
          />
        </>
      )}
    </div>
  );
}
