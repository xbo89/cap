import { cn } from "@/lib/utils";

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  displayValue?: string;
  onChange: (value: number) => void;
  className?: string;
}

export function Slider({
  value,
  min,
  max,
  step = 0.01,
  label,
  displayValue,
  onChange,
  className,
}: SliderProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between">
        <label className="text-[10px] text-[#6e6e6e]">
          {label}
        </label>
        <span className="text-[10px] text-[#6e6e6e] tabular-nums">
          {displayValue ?? value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-white/[0.06] rounded-full appearance-none cursor-pointer accent-[#5b5bd6]"
      />
    </div>
  );
}
