use crate::capture::mouse::MouseEvent;
use crate::export::zoom::{Point, ZoomCalculator, ZoomConfig};
use crate::project::{Clip, ExportFormat, ExportQuality, ExportSettings, Subtitle};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

/// Check if a video file has an audio stream using ffprobe
fn has_audio_stream(path: &Path) -> bool {
    Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-select_streams", "a",
            "-show_entries", "stream=codec_type",
            "-of", "csv=p=0",
            path.to_str().unwrap_or(""),
        ])
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportProgress {
    pub percent: f64,
    pub current_frame: u64,
    pub total_frames: u64,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct ExportJob {
    pub session_dir: PathBuf,
    pub output_path: PathBuf,
    pub clips: Vec<Clip>,
    pub subtitles: Vec<Subtitle>,
    pub zoom_config: Option<ZoomConfig>,
    pub mouse_events: Vec<MouseEvent>,
    pub export_settings: ExportSettings,
    pub video_width: u32,
    pub video_height: u32,
    pub duration: f64,
    pub fps: f64,
}

/// Cancel flag shared between export thread and main thread
pub type CancelFlag = Arc<Mutex<bool>>;

/// Run the export pipeline using ffmpeg CLI.
///
/// Strategy for zoom effect:
/// 1. Pre-compute viewport positions for each frame
/// 2. Generate a ffmpeg filter script using sendcmd/crop/scale
/// 3. Since sendcmd is complex, we use a simpler approach:
///    - First pass: apply clip trimming to create a trimmed video
///    - Second pass: use the `zoompan` filter or frame-by-frame crop via concat
///
/// Simplified approach: Generate concat segments with per-segment crop values,
/// or use ffmpeg's expression-based crop filter with interpolated keyframes.
///
/// Practical approach: Write a "viewport script" and use ffmpeg's
/// sendcmd filter to dynamically change crop parameters per frame.
pub fn run_export<F>(job: ExportJob, cancel: CancelFlag, on_progress: F) -> Result<PathBuf, String>
where
    F: Fn(ExportProgress) + Send + 'static,
{
    let video_path = job.session_dir.join("video.mp4");
    if !video_path.exists() {
        return Err("Source video not found".into());
    }

    let total_frames = (job.duration * job.fps) as u64;
    let input_has_audio = has_audio_stream(&video_path);

    // Build clip filter
    let clip_filter = build_clip_filter(&job.clips, input_has_audio, job.fps, job.video_width, job.video_height);

    // Build zoom filter if enabled
    let zoom_filter = if let Some(ref zoom_cfg) = job.zoom_config {
        build_zoom_filter(
            zoom_cfg,
            &job.mouse_events,
            job.video_width,
            job.video_height,
            job.fps,
            job.duration,
        )
    } else {
        String::new()
    };

    // Build subtitle overlay (renders PNGs via Core Graphics, no libass needed)
    let sub_overlay = if job.export_settings.burn_subtitles {
        build_subtitle_overlay(&job.subtitles, &job.clips, job.video_width, job.video_height)
    } else {
        None
    };

    let has_zoom = !zoom_filter.is_empty();
    let has_subs = sub_overlay.is_some();

    // Determine if we need a pre-pass to flatten clips into a single stream.
    // Complex clip filters (multi-clip concat) require filter_complex, so we
    // first produce a trimmed+concatenated intermediate, then apply zoom/subs.
    let needs_clip_prepass = matches!(&clip_filter, ClipFilter::Complex { .. }) && (has_zoom || has_subs);

    let working_video = if needs_clip_prepass {
        // Pre-pass: concat clips into a temp file
        let temp_path = std::env::temp_dir().join("screencap_clip_concat.mp4");
        let progress_scale = if has_zoom && has_subs { 0.33 } else { 0.5 };

        on_progress(ExportProgress {
            percent: 0.0, current_frame: 0, total_frames,
            status: "Concatenating clips...".into(),
        });

        run_ffmpeg_concat(
            &video_path, &temp_path, &clip_filter,
            input_has_audio, &job, &cancel,
            |p| on_progress(ExportProgress {
                percent: p.percent * progress_scale,
                status: "Concatenating clips...".into(), ..p
            }),
        )?;

        temp_path
    } else {
        video_path.clone()
    };

    // After clip pre-pass, the working video is already trimmed/concatenated.
    // Build the remaining filter chain.
    let (remaining_vf, remaining_af) = if needs_clip_prepass {
        // Clips already applied in pre-pass
        (String::new(), String::new())
    } else {
        match &clip_filter {
            ClipFilter::None => (String::new(), String::new()),
            ClipFilter::Simple { video, audio } => (video.clone(), audio.clone()),
            ClipFilter::Complex { .. } => {
                // Complex but no zoom/subs: handled directly below
                (String::new(), String::new())
            }
        }
    };

    // If complex clip filter with no zoom/subs, run it directly
    if matches!(&clip_filter, ClipFilter::Complex { .. }) && !needs_clip_prepass {
        run_ffmpeg_concat(
            &video_path, &job.output_path, &clip_filter,
            input_has_audio, &job, &cancel, &on_progress,
        )?;
    } else if has_zoom && has_subs {
        // Two-pass: zoom first → temp, then subtitle overlay → final
        let temp_zoom = std::env::temp_dir().join("screencap_export_zoom.mp4");
        let base_pct = if needs_clip_prepass { 33.0 } else { 0.0 };
        let pass_scale = if needs_clip_prepass { 0.33 } else { 0.5 };

        let mut pass1_filters = Vec::new();
        if !remaining_vf.is_empty() { pass1_filters.push(remaining_vf); }
        pass1_filters.push(zoom_filter);

        on_progress(ExportProgress {
            percent: base_pct, current_frame: 0, total_frames,
            status: "Applying zoom...".into(),
        });

        run_ffmpeg_simple(
            &working_video, &temp_zoom,
            &pass1_filters.join(","), &remaining_af,
            true, None, &job, &cancel,
            |p| on_progress(ExportProgress {
                percent: base_pct + p.percent * pass_scale,
                status: "Applying zoom...".into(), ..p
            }),
        )?;

        let sub_base = base_pct + 100.0 * pass_scale;
        on_progress(ExportProgress {
            percent: sub_base, current_frame: 0, total_frames,
            status: "Burning subtitles...".into(),
        });

        run_ffmpeg_simple(
            &temp_zoom, &job.output_path,
            "null", "",
            false, sub_overlay.as_ref(), &job, &cancel,
            |p| on_progress(ExportProgress {
                percent: sub_base + p.percent * pass_scale,
                status: "Burning subtitles...".into(), ..p
            }),
        )?;

        let _ = std::fs::remove_file(&temp_zoom);
    } else if !matches!(&clip_filter, ClipFilter::Complex { .. }) || needs_clip_prepass {
        // Single pass: simple clip filter + optional zoom or subs
        let mut filters = Vec::new();
        if !remaining_vf.is_empty() { filters.push(remaining_vf); }
        if has_zoom { filters.push(zoom_filter); }

        let filter_chain = if filters.is_empty() { "null".to_string() } else { filters.join(",") };
        let base_pct = if needs_clip_prepass { 50.0 } else { 0.0 };
        let pass_scale = if needs_clip_prepass { 0.5 } else { 1.0 };

        run_ffmpeg_simple(
            &working_video, &job.output_path,
            &filter_chain, &remaining_af,
            has_zoom, sub_overlay.as_ref(), &job, &cancel,
            |p| on_progress(ExportProgress {
                percent: base_pct + p.percent * pass_scale,
                ..p
            }),
        )?;
    }

    // Clean up temp files
    if needs_clip_prepass {
        let _ = std::fs::remove_file(&working_video);
    }

    on_progress(ExportProgress {
        percent: 100.0,
        current_frame: total_frames,
        total_frames,
        status: "Complete".into(),
    });

    Ok(job.output_path)
}

/// Run ffmpeg with a concat-based filter_complex for multi-clip export.
fn run_ffmpeg_concat<F>(
    input_path: &Path,
    output_path: &Path,
    clip_filter: &ClipFilter,
    has_audio: bool,
    job: &ExportJob,
    cancel: &CancelFlag,
    on_progress: F,
) -> Result<(), String>
where
    F: Fn(ExportProgress),
{
    let filter_complex = match clip_filter {
        ClipFilter::Complex { filter_complex, .. } => filter_complex,
        _ => return Err("run_ffmpeg_concat called without Complex filter".into()),
    };

    let total_frames = (job.duration * job.fps) as u64;
    let (vcodec, vcodec_args) = get_codec_args(&job.export_settings);

    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-y", "-i", input_path.to_str().unwrap()]);
    cmd.args(["-filter_complex", filter_complex]);
    cmd.args(["-map", "[cv]"]);
    if has_audio {
        cmd.args(["-map", "[ca]"]);
    }

    cmd.args(["-r", &format!("{}", job.fps)]);
    cmd.args(&vcodec_args);
    cmd.args(["-c:v", &vcodec]);

    if has_audio {
        cmd.args(["-c:a", "aac", "-b:a", "128k"]);
    } else {
        cmd.args(["-an"]);
    }

    cmd.args(["-progress", "pipe:1", "-nostats"]);
    cmd.arg(output_path.to_str().unwrap());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    run_ffmpeg_child(cmd, total_frames, cancel, on_progress)
}

/// Run a single ffmpeg encoding pass with simple -vf/-af filter chains.
/// If `sub_overlay` is provided, subtitle PNGs are added as extra inputs
/// and composited via `-filter_complex` with overlay filters.
fn run_ffmpeg_simple<F>(
    input_path: &Path,
    output_path: &Path,
    filter_chain: &str,
    audio_filter: &str,
    use_filter_script: bool,
    sub_overlay: Option<&SubtitleOverlay>,
    job: &ExportJob,
    cancel: &CancelFlag,
    on_progress: F,
) -> Result<(), String>
where
    F: Fn(ExportProgress),
{
    let total_frames = (job.duration * job.fps) as u64;
    let (vcodec, vcodec_args) = get_codec_args(&job.export_settings);
    let has_audio = has_audio_stream(input_path);

    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-y", "-i", input_path.to_str().unwrap()]);

    if let Some(overlay) = sub_overlay {
        for png in &overlay.png_inputs {
            cmd.args(["-i", png.to_str().unwrap()]);
        }

        let video_filter = if filter_chain != "null" && !filter_chain.is_empty() {
            format!("[0:v]{}", filter_chain)
        } else {
            "[0:v]copy".to_string()
        };

        let audio_part = if has_audio && !audio_filter.is_empty() {
            format!(";[0:a]{}[aout]", audio_filter)
        } else {
            String::new()
        };

        let full_complex = format!(
            "{}[base];{}{}",
            video_filter,
            overlay.filter_complex.replace("[0:v]", "[base]"),
            audio_part,
        );

        cmd.args(["-filter_complex", &full_complex]);
        cmd.args(["-map", "[v]"]);
        if has_audio {
            if !audio_filter.is_empty() {
                cmd.args(["-map", "[aout]"]);
            } else {
                cmd.args(["-map", "0:a?"]);
            }
        }
    } else if use_filter_script {
        let script = std::env::temp_dir().join("screencap_filter.txt");
        std::fs::write(&script, filter_chain)
            .map_err(|e| format!("Failed to write filter script: {}", e))?;
        cmd.args(["-filter_script:v", script.to_str().unwrap()]);
        if has_audio && !audio_filter.is_empty() {
            cmd.args(["-af", audio_filter]);
        }
    } else {
        cmd.args(["-vf", filter_chain]);
        if has_audio && !audio_filter.is_empty() {
            cmd.args(["-af", audio_filter]);
        }
    }

    cmd.args(["-r", &format!("{}", job.fps)]);
    cmd.args(&vcodec_args);
    cmd.args(["-c:v", &vcodec]);

    if has_audio {
        cmd.args(["-c:a", "aac", "-b:a", "128k"]);
    } else {
        cmd.args(["-an"]);
    }

    cmd.args(["-progress", "pipe:1", "-nostats"]);
    cmd.arg(output_path.to_str().unwrap());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    run_ffmpeg_child(cmd, total_frames, cancel, on_progress)
}

/// Spawn an ffmpeg process and monitor its progress until completion.
fn run_ffmpeg_child<F>(
    mut cmd: Command,
    total_frames: u64,
    cancel: &CancelFlag,
    on_progress: F,
) -> Result<(), String>
where
    F: Fn(ExportProgress),
{
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;

    let stderr = child.stderr.take();
    let stderr_handle = std::thread::spawn(move || {
        stderr.map(|mut s| {
            let mut buf = String::new();
            std::io::Read::read_to_string(&mut s, &mut buf).ok();
            buf
        }).unwrap_or_default()
    });

    let stdout = child.stdout.take().ok_or("Failed to capture ffmpeg stdout")?;
    let reader = BufReader::new(stdout);

    for line in reader.lines() {
        if *cancel.lock().unwrap() {
            let _ = child.kill();
            return Err("Export cancelled".into());
        }
        if let Ok(line) = line {
            if let Some(frame_str) = line.strip_prefix("frame=") {
                if let Ok(frame) = frame_str.trim().parse::<u64>() {
                    let percent = if total_frames > 0 {
                        (frame as f64 / total_frames as f64 * 100.0).min(100.0)
                    } else {
                        0.0
                    };
                    on_progress(ExportProgress {
                        percent,
                        current_frame: frame,
                        total_frames,
                        status: "Encoding...".into(),
                    });
                }
            }
        }
    }

    let status = child.wait().map_err(|e| format!("ffmpeg wait failed: {}", e))?;
    let stderr_output = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        let tail: String = stderr_output.lines().rev().take(20)
            .collect::<Vec<_>>().into_iter().rev()
            .collect::<Vec<_>>().join("\n");
        return Err(format!("ffmpeg export failed:\n{}", tail));
    }

    Ok(())
}

/// Describes how clips should be filtered during export.
enum ClipFilter {
    /// No trimming needed (single clip covers full source).
    None,
    /// Single clip: simple trim filters for -vf/-af.
    Simple { video: String, audio: String },
    /// Multiple clips: filter_complex with concat, outputs [cv] and [ca].
    Complex { filter_complex: String, has_audio: bool },
}

/// Build the clip filter based on the timeline clip arrangement.
/// Clips are ordered by timeline position (start_time) and each maps
/// to source range [media_offset, media_offset + duration].
/// Gaps between clips produce black video + silent audio segments so that
/// the output timeline matches the editor timeline exactly.
fn build_clip_filter(clips: &[Clip], has_audio: bool, fps: f64, width: u32, height: u32) -> ClipFilter {
    let mut sorted: Vec<&Clip> = clips.iter().collect();
    sorted.sort_by(|a, b| a.start_time.partial_cmp(&b.start_time).unwrap());

    if sorted.len() <= 1 {
        if let Some(clip) = sorted.first() {
            let src_start = clip.media_offset;
            let src_end = src_start + (clip.end_time - clip.start_time);
            let vf = format!(
                "trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS",
                src_start, src_end
            );
            let af = format!(
                "atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS",
                src_start, src_end
            );
            return ClipFilter::Simple { video: vf, audio: af };
        }
        return ClipFilter::None;
    }

    // Multiple clips: use trim per clip + concat filter in timeline order.
    // Gaps between clips are filled with black video + silent audio.
    let mut parts = Vec::new();
    let mut concat_inputs = String::new();
    let mut segment_idx = 0usize;
    let mut cursor = sorted[0].start_time; // start of first clip on timeline

    // If first clip doesn't start at 0, insert a leading gap
    if cursor > 0.01 {
        let gap_dur = cursor;
        parts.push(format!(
            "color=c=black:s={width}x{height}:r={fps}:d={gap_dur:.3},format=yuv420p,setpts=PTS-STARTPTS[vgap{segment_idx}]"
        ));
        concat_inputs.push_str(&format!("[vgap{segment_idx}]"));
        if has_audio {
            parts.push(format!(
                "anullsrc=r=48000:cl=stereo,atrim=0:{gap_dur:.3},asetpts=PTS-STARTPTS[agap{segment_idx}]"
            ));
            concat_inputs.push_str(&format!("[agap{segment_idx}]"));
        }
        segment_idx += 1;
    }

    for (i, clip) in sorted.iter().enumerate() {
        // Insert gap segment if there's space before this clip
        if i > 0 {
            let gap_start = sorted[i - 1].end_time;
            let gap_dur = clip.start_time - gap_start;
            if gap_dur > 0.01 {
                parts.push(format!(
                    "color=c=black:s={width}x{height}:r={fps}:d={gap_dur:.3},format=yuv420p,setpts=PTS-STARTPTS[vgap{segment_idx}]"
                ));
                concat_inputs.push_str(&format!("[vgap{segment_idx}]"));
                if has_audio {
                    parts.push(format!(
                        "anullsrc=r=48000:cl=stereo,atrim=0:{gap_dur:.3},asetpts=PTS-STARTPTS[agap{segment_idx}]"
                    ));
                    concat_inputs.push_str(&format!("[agap{segment_idx}]"));
                }
                segment_idx += 1;
            }
        }

        // Clip segment
        let src_start = clip.media_offset;
        let src_end = src_start + (clip.end_time - clip.start_time);
        parts.push(format!(
            "[0:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS[v{segment_idx}]",
            src_start, src_end
        ));
        concat_inputs.push_str(&format!("[v{segment_idx}]"));
        if has_audio {
            parts.push(format!(
                "[0:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS[a{segment_idx}]",
                src_start, src_end
            ));
            concat_inputs.push_str(&format!("[a{segment_idx}]"));
        }
        segment_idx += 1;
    }

    let a_flag = if has_audio { 1 } else { 0 };
    parts.push(format!(
        "{concat_inputs}concat=n={segment_idx}:v=1:a={a_flag}[cv]{ca}",
        ca = if has_audio { "[ca]" } else { "" },
    ));

    ClipFilter::Complex {
        filter_complex: parts.join(";"),
        has_audio,
    }
}

/// Remap a timeline time to the output time.
/// Since gaps are preserved as black frames in the export, the output timeline
/// starts from the first clip's start_time. Subtract that offset so output starts at 0.
fn remap_to_output_time(time: f64, clips: &[Clip]) -> f64 {
    let mut sorted: Vec<&Clip> = clips.iter().collect();
    sorted.sort_by(|a, b| a.start_time.partial_cmp(&b.start_time).unwrap());

    let timeline_start = sorted.first().map(|c| c.start_time).unwrap_or(0.0);
    (time - timeline_start).max(0.0)
}

/// Build zoom crop filter using ffmpeg expression-based crop.
///
/// We pre-compute viewport keyframes and interpolate in the crop expression
/// using ffmpeg's expression evaluator with linear interpolation on `t`.
fn build_zoom_filter(
    config: &ZoomConfig,
    mouse_events: &[MouseEvent],
    width: u32,
    height: u32,
    fps: f64,
    duration: f64,
) -> String {
    if mouse_events.is_empty() {
        return String::new();
    }

    let mut calc = ZoomCalculator::new(config.clone(), width as f64, height as f64);
    let scale_factor = 2.0;

    // Step 1: Compute viewport for EVERY mouse event at native rate.
    // This matches the preview's 60fps exponential smoothing exactly.
    let mut all_viewports: Vec<(f64, f64, f64, f64, f64)> = Vec::new(); // (t, x, y, w, h)
    let mut prev_t = 0.0;

    for event in mouse_events {
        let t = event.timestamp_us as f64 / 1_000_000.0;
        if t > duration { break; }

        let mouse = Point {
            x: event.x * scale_factor,
            y: event.y * scale_factor,
        };

        let dt = if t > prev_t { t - prev_t } else { 1.0 / 60.0 };
        prev_t = t;

        let vp = calc.compute(mouse, dt);
        all_viewports.push((t, vp.src_x, vp.src_y, vp.src_w, vp.src_h));
    }

    if all_viewports.is_empty() {
        return String::new();
    }

    // Step 2: Downsample to evenly-spaced keyframes for ffmpeg expressions.
    // Use enough keyframes (10fps) for smooth interpolation, max 100.
    let kf_interval = 0.1; // 10fps keyframes
    let num_kf = ((duration / kf_interval) as usize + 1).min(200);
    let mut keyframes: Vec<(f64, f64, f64, f64, f64)> = Vec::new();
    let mut vp_idx = 0;

    for i in 0..num_kf {
        let t = i as f64 * kf_interval;
        // Find the viewport closest to this time
        while vp_idx + 1 < all_viewports.len() && all_viewports[vp_idx + 1].0 <= t {
            vp_idx += 1;
        }
        if vp_idx < all_viewports.len() {
            let vp = &all_viewports[vp_idx];
            keyframes.push((t, vp.1, vp.2, vp.3, vp.4));
        }
    }

    if keyframes.is_empty() {
        return String::new();
    }

    // Downsample further if too many keyframes for ffmpeg expression length
    let max_kf = 60;
    let step = if keyframes.len() > max_kf {
        keyframes.len() / max_kf
    } else {
        1
    };
    let kf: Vec<_> = keyframes.iter().step_by(step).collect();

    let crop_w = kf[0].3 as u32;
    let crop_h = kf[0].4 as u32;

    // Build piecewise expression for x position
    // Escape commas with \, so ffmpeg's filtergraph parser doesn't treat them as filter separators
    let x_expr = build_piecewise_expr(&kf, |k| k.1).replace(',', "\\,");
    let y_expr = build_piecewise_expr(&kf, |k| k.2).replace(',', "\\,");

    format!(
        "crop=w={}:h={}:x={}:y={},scale={}:{}",
        crop_w, crop_h, x_expr, y_expr, width, height
    )
}

/// Build a piecewise-linear ffmpeg expression from keyframes.
fn build_piecewise_expr(
    keyframes: &[&(f64, f64, f64, f64, f64)],
    get_val: impl Fn(&(f64, f64, f64, f64, f64)) -> f64,
) -> String {
    if keyframes.len() <= 1 {
        return format!("{:.0}", get_val(keyframes[0]));
    }

    // Build nested if expressions: if(lt(t,t1), lerp(v0,v1,t), if(...))
    let mut expr = format!("{:.0}", get_val(keyframes.last().unwrap()));

    for i in (0..keyframes.len() - 1).rev() {
        let t0 = keyframes[i].0;
        let t1 = keyframes[i + 1].0;
        let v0 = get_val(keyframes[i]);
        let v1 = get_val(keyframes[i + 1]);

        if (t1 - t0).abs() < 0.001 {
            continue;
        }

        // Linear interpolation: v0 + (v1-v0) * (t-t0)/(t1-t0)
        let slope = (v1 - v0) / (t1 - t0);
        let interp = if slope.abs() < 0.1 {
            format!("{:.0}", v0) // nearly constant
        } else {
            format!("{:.0}+{:.2}*(t-{:.3})", v0, slope, t0)
        };

        expr = format!("if(lt(t,{:.3}),{},{})", t1, interp, expr);
    }

    expr
}

/// Burn subtitles by rendering text to PNGs via Swift + Core Graphics (always on macOS),
/// then compositing with ffmpeg's overlay filter. No libass/freetype dependency.
fn build_subtitle_overlay(
    subtitles: &[Subtitle],
    clips: &[Clip],
    video_width: u32,
    video_height: u32,
) -> Option<SubtitleOverlay> {
    if subtitles.is_empty() {
        return None;
    }

    let tmp_dir = std::env::temp_dir().join("screencap_subs");
    let _ = std::fs::create_dir_all(&tmp_dir);
    // Clean old PNGs
    if let Ok(entries) = std::fs::read_dir(&tmp_dir) {
        for e in entries.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }

    let mut inputs = Vec::new();
    let mut filter_parts = Vec::new();

    for (i, sub) in subtitles.iter().enumerate() {
        let png_path = tmp_dir.join(format!("sub_{}.png", i));

        let (font_size, scale, opacity, pos_x, pos_y, rotation,
             fr, fg, fb, sr, sg, sb, sw, bg_color, letter_spacing) =
            if let Some(ref s) = sub.style {
                (s.font_size, s.scale, s.opacity, s.x, s.y, s.rotation,
                 parse_hex_component(&s.font_color, 0),
                 parse_hex_component(&s.font_color, 1),
                 parse_hex_component(&s.font_color, 2),
                 parse_hex_component(&s.stroke_color, 0),
                 parse_hex_component(&s.stroke_color, 1),
                 parse_hex_component(&s.stroke_color, 2),
                 s.stroke_width * s.scale,
                 s.bg_color.clone(),
                 s.letter_spacing)
            } else {
                (48.0, 1.0, 1.0, 0.5, 0.85, 0.0,
                 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 2.0,
                 "transparent".to_string(), 0.0)
            };

        let eff_size = (font_size * scale).max(12.0);
        let text_escaped = sub.text.replace('\\', "\\\\").replace('"', "\\\"");
        let png_str = png_path.to_str().unwrap();

        // Parse background color
        let (has_bg, bg_r, bg_g, bg_b) = if bg_color != "transparent" && !bg_color.is_empty() {
            (true,
             parse_hex_component(&bg_color, 0),
             parse_hex_component(&bg_color, 1),
             parse_hex_component(&bg_color, 2))
        } else {
            (false, 0.0, 0.0, 0.0)
        };

        // Use Swift to render text to transparent PNG via CoreText + CoreGraphics
        // Key: kCTForegroundColorFromContextAttributeName makes CTLineDraw use context colors
        let swift_code = format!(r#"
import CoreGraphics; import CoreText; import ImageIO; import Foundation
let w={vw},h={vh}
let cs=CGColorSpaceCreateDeviceRGB()
guard let ctx=CGContext(data:nil,width:w,height:h,bitsPerComponent:8,bytesPerRow:w*4,space:cs,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {{exit(1)}}
ctx.clear(CGRect(x:0,y:0,width:w,height:h))
let font=CTFontCreateWithName("Helvetica-Bold" as CFString,{sz:.6},nil)
let attrs:[CFString:Any]=[kCTFontAttributeName:font,kCTForegroundColorFromContextAttributeName:true as CFBoolean]
let astr=CFAttributedStringCreate(nil,"{text}" as CFString,attrs as CFDictionary)!
let line=CTLineCreateWithAttributedString(astr)
let bounds=CTLineGetBoundsWithOptions(line,CTLineBoundsOptions())
let cx=Double(w)*{px:.6}
let cy=Double(h)*(1.0-{py:.6})
let fillColor=CGColor(colorSpace:cs,components:[{fr:.6},{fg:.6},{fb:.6},{op:.6}])!
let strokeColor=CGColor(colorSpace:cs,components:[{sr:.6},{sg:.6},{sb:.6},{op:.6}])!
// Transform: translate to center, then rotate
ctx.saveGState()
ctx.translateBy(x:cx,y:cy)
if abs({rot:.6})>0.01 {{
  ctx.rotate(by:{rot:.6}*Double.pi/(-180.0))
}}
// Background rect
if {has_bg} {{
  let bgColor=CGColor(colorSpace:cs,components:[{bg_r:.6},{bg_g:.6},{bg_b:.6},{op:.6}])!
  ctx.setFillColor(bgColor)
  ctx.fill(CGRect(x:-bounds.size.width/2.0-6.0,y:-bounds.size.height/2.0-2.0,width:bounds.size.width+12.0,height:bounds.size.height+4.0))
}}
// Position text relative to center
ctx.textPosition=CGPoint(x:-bounds.size.width/2.0,y:-bounds.size.height/2.0+{sz:.6}*0.25)
if {sw:.6}>0.0 {{
  ctx.setTextDrawingMode(.stroke)
  ctx.setStrokeColor(strokeColor)
  ctx.setLineWidth({sw:.6})
  ctx.setLineJoin(.round)
  CTLineDraw(line,ctx)
  ctx.textPosition=CGPoint(x:-bounds.size.width/2.0,y:-bounds.size.height/2.0+{sz:.6}*0.25)
}}
ctx.setTextDrawingMode(.fill)
ctx.setFillColor(fillColor)
CTLineDraw(line,ctx)
ctx.restoreGState()
guard let img=ctx.makeImage() else {{exit(1)}}
let url=URL(fileURLWithPath:"{path}") as CFURL
guard let dst=CGImageDestinationCreateWithURL(url,"public.png" as CFString,1,nil) else {{exit(1)}}
CGImageDestinationAddImage(dst,img,nil)
CGImageDestinationFinalize(dst)
"#,
            vw = video_width,
            vh = video_height,
            sz = eff_size,
            text = text_escaped,
            px = pos_x,
            py = pos_y,
            rot = rotation,
            fr = fr, fg = fg, fb = fb,
            sr = sr, sg = sg, sb = sb,
            sw = sw, op = opacity,
            has_bg = has_bg,
            bg_r = bg_r, bg_g = bg_g, bg_b = bg_b,
            path = png_str,
        );

        let result = Command::new("swift")
            .arg("-e")
            .arg(&swift_code)
            .stderr(Stdio::piped())
            .output();

        match result {
            Ok(out) if png_path.exists() => { let _ = out; }
            Ok(out) => {
                eprintln!("Subtitle render failed for '{}': {}", sub.text, String::from_utf8_lossy(&out.stderr));
                continue;
            }
            Err(e) => {
                eprintln!("Failed to run swift for subtitle: {}", e);
                continue;
            }
        }

        let input_idx = inputs.len() + 1;
        inputs.push(png_path);

        let input_label = if i == 0 { "0:v".to_string() } else { format!("tmp{}", i - 1) };
        let output_label = if i == subtitles.len() - 1 { "v".to_string() } else { format!("tmp{}", i) };

        // Remap subtitle times from timeline to output (after clip concat removes gaps)
        let out_start = remap_to_output_time(sub.start_time, clips);
        let out_end = remap_to_output_time(sub.end_time, clips);

        filter_parts.push(format!(
            "[{input}][{idx}:v]overlay=0:0:enable='between(t,{start:.3},{end:.3})'[{output}]",
            input = input_label,
            idx = input_idx,
            start = out_start,
            end = out_end,
            output = output_label,
        ));
    }

    if filter_parts.is_empty() {
        return None;
    }

    Some(SubtitleOverlay {
        png_inputs: inputs,
        filter_complex: filter_parts.join(";"),
    })
}

struct SubtitleOverlay {
    png_inputs: Vec<PathBuf>,
    filter_complex: String,
}

fn parse_hex_component(hex: &str, idx: usize) -> f64 {
    let hex = hex.trim_start_matches('#');
    if hex.len() < 6 { return 1.0; }
    let start = idx * 2;
    u8::from_str_radix(&hex[start..start + 2], 16)
        .map(|v| v as f64 / 255.0)
        .unwrap_or(1.0)
}


fn get_codec_args(settings: &ExportSettings) -> (String, Vec<String>) {
    match settings.format {
        ExportFormat::Mp4H264 => {
            let bitrate = match settings.quality {
                ExportQuality::Low => "2000k",
                ExportQuality::Medium => "5000k",
                ExportQuality::High => "8000k",
                ExportQuality::Ultra => "15000k",
            };
            (
                "h264_videotoolbox".to_string(),
                vec!["-b:v".to_string(), bitrate.to_string(), "-pix_fmt".to_string(), "yuv420p".to_string()],
            )
        }
        ExportFormat::Mp4H265 => {
            let bitrate = match settings.quality {
                ExportQuality::Low => "1500k",
                ExportQuality::Medium => "3500k",
                ExportQuality::High => "6000k",
                ExportQuality::Ultra => "12000k",
            };
            (
                "hevc_videotoolbox".to_string(),
                vec!["-b:v".to_string(), bitrate.to_string(), "-pix_fmt".to_string(), "yuv420p".to_string()],
            )
        }
        ExportFormat::WebmVp9 => {
            let crf = match settings.quality {
                ExportQuality::Low => "40",
                ExportQuality::Medium => "33",
                ExportQuality::High => "28",
                ExportQuality::Ultra => "20",
            };
            (
                "libvpx-vp9".to_string(),
                vec!["-crf".to_string(), crf.to_string(), "-b:v".to_string(), "0".to_string()],
            )
        }
    }
}
