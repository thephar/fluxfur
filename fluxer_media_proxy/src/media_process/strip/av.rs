// SPDX-License-Identifier: AGPL-3.0-or-later

use super::super::native_runtime::ensure_vips_init;
use super::super::{MediaError, native_optional_deadline, native_status_error};
use crate::native::{self, FluxerAVAudioDurationOut, NativeStatus};
use std::{
    ffi::{CStr, CString},
    os::unix::ffi::OsStrExt,
    path::Path,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AvContainer {
    demuxer: &'static CStr,
    muxer: &'static CStr,
    faststart: bool,
}

pub fn av_container(content_type: &str) -> Option<AvContainer> {
    let muxer: &'static CStr = if content_type.contains("3gpp") {
        c"3gp"
    } else if content_type.contains("mp4") {
        c"mp4"
    } else if content_type.contains("webm") {
        c"webm"
    } else if content_type.contains("quicktime") {
        c"mov"
    } else if content_type.contains("x-matroska") {
        c"matroska"
    } else if content_type.contains("x-msvideo") {
        c"avi"
    } else if content_type.contains("x-flv") {
        c"flv"
    } else if content_type.contains("mp2t") {
        c"mpegts"
    } else if content_type.contains("mpeg") {
        if content_type.starts_with("audio/") {
            c"mp3"
        } else {
            c"mpeg"
        }
    } else if content_type.contains("x-ms-wmv") {
        c"asf"
    } else if content_type.contains("wav") {
        c"wav"
    } else if content_type.contains("flac") {
        c"flac"
    } else if content_type.contains("aac") {
        c"adts"
    } else if content_type.contains("aiff") {
        c"aiff"
    } else if content_type.contains("ogg") {
        c"ogg"
    } else {
        return None;
    };
    let demuxer = match muxer.to_bytes() {
        b"3gp" | b"mov" => c"mp4",
        b"webm" => c"matroska",
        b"adts" => c"aac",
        _ => muxer,
    };
    Some(AvContainer {
        demuxer,
        muxer,
        faststart: matches!(muxer.to_bytes(), b"mp4" | b"mov" | b"3gp"),
    })
}

pub fn strip_av_metadata(
    input: &[u8],
    container: AvContainer,
    output: &Path,
    deadline_ms: Option<i64>,
) -> Result<(), MediaError> {
    ensure_vips_init()?;
    if input.is_empty() {
        return Err(MediaError::MediaDecodeFailed);
    }
    let output =
        CString::new(output.as_os_str().as_bytes()).map_err(|_| MediaError::MediaEncodeFailed)?;
    let rc = unsafe {
        native::fluxer_av_strip_metadata(
            input.as_ptr().cast(),
            input.len(),
            container.demuxer.as_ptr(),
            container.muxer.as_ptr(),
            i32::from(container.faststart),
            output.as_ptr(),
            native_optional_deadline(deadline_ms),
        )
    };
    match native_status_error(NativeStatus::from_code(rc), MediaError::MediaDecodeFailed) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn positive(seconds: f64) -> Option<f64> {
    (seconds.is_finite() && seconds > 0.0).then_some(seconds)
}

pub fn audio_duration_seconds(
    input: &[u8],
    deadline_ms: Option<i64>,
) -> Result<Option<f64>, MediaError> {
    ensure_vips_init()?;
    if input.is_empty() {
        return Err(MediaError::MediaDecodeFailed);
    }
    let mut out = FluxerAVAudioDurationOut::default();
    let rc = unsafe {
        native::fluxer_av_audio_duration(
            input.as_ptr().cast(),
            input.len(),
            native_optional_deadline(deadline_ms),
            &mut out,
        )
    };
    if let Some(error) =
        native_status_error(NativeStatus::from_code(rc), MediaError::MediaDecodeFailed)
    {
        return Err(error);
    }
    let frames = (out.frame_count > 0).then_some(out.frames_seconds);
    Ok(frames
        .or_else(|| positive(out.stream_seconds))
        .or_else(|| positive(out.format_seconds)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav_with_info(samples: u32, sample_rate: u32) -> Vec<u8> {
        let data: Vec<u8> = (0..samples)
            .flat_map(|i| (((i % 64) as i16 - 32) * 512).to_le_bytes())
            .collect();
        let mut info = b"INFO".to_vec();
        info.extend_from_slice(b"INAM");
        info.extend_from_slice(&14u32.to_le_bytes());
        info.extend_from_slice(b"secret title\0\0");
        let mut body = b"WAVEfmt ".to_vec();
        body.extend_from_slice(&16u32.to_le_bytes());
        body.extend_from_slice(&1u16.to_le_bytes());
        body.extend_from_slice(&1u16.to_le_bytes());
        body.extend_from_slice(&sample_rate.to_le_bytes());
        body.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        body.extend_from_slice(&2u16.to_le_bytes());
        body.extend_from_slice(&16u16.to_le_bytes());
        body.extend_from_slice(b"LIST");
        body.extend_from_slice(&(info.len() as u32).to_le_bytes());
        body.extend_from_slice(&info);
        body.extend_from_slice(b"data");
        body.extend_from_slice(&(data.len() as u32).to_le_bytes());
        body.extend_from_slice(&data);
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&(body.len() as u32).to_le_bytes());
        wav.extend_from_slice(&body);
        wav
    }

    fn flv_tag(kind: u8, timestamp_ms: u32, data: &[u8]) -> Vec<u8> {
        let mut tag = vec![kind];
        tag.extend_from_slice(&(data.len() as u32).to_be_bytes()[1..]);
        tag.extend_from_slice(&timestamp_ms.to_be_bytes()[1..]);
        tag.push((timestamp_ms >> 24) as u8);
        tag.extend_from_slice(&[0, 0, 0]);
        tag.extend_from_slice(data);
        tag.extend_from_slice(&(11 + data.len() as u32).to_be_bytes());
        tag
    }

    #[test]
    fn remux_refuses_streams_that_appear_after_probing() {
        let mut flv = b"FLV\x01\x04\x00\x00\x00\x09\x00\x00\x00\x00".to_vec();
        let mut audio = vec![0x3E];
        audio.extend_from_slice(&[0; 8820]);
        for index in 0..700 {
            flv.extend(flv_tag(8, index * 100, &audio));
        }
        let mut video = vec![0x12];
        video.extend_from_slice(&[0; 64]);
        for index in 0..10 {
            flv.extend(flv_tag(9, 70_000 + index * 100, &video));
        }
        let container = av_container("video/x-flv").expect("flv container");
        let output = tempfile::NamedTempFile::new().expect("output file");

        assert!(strip_av_metadata(&flv, container, output.path(), None).is_err());
    }

    #[test]
    fn remux_drops_container_tags_and_keeps_every_sample() {
        let input = wav_with_info(48_000 * 3 / 2, 48_000);
        let container = av_container("audio/wav").expect("wav container");
        let output = tempfile::NamedTempFile::new().expect("output file");

        strip_av_metadata(&input, container, output.path(), None).expect("stripped wav");

        let stripped = std::fs::read(output.path()).expect("stripped bytes");
        assert!(!stripped.windows(6).any(|window| window == b"secret"));
        let duration = audio_duration_seconds(&stripped, None).expect("duration");
        assert_eq!(Some(1.5), duration);
    }
}
