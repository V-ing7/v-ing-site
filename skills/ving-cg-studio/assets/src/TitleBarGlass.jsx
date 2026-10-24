import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from 'remotion';

/**
 * TitleBarGlass — iOS 液态玻璃风格透明标题条
 *
 * 设计原则：
 * 1. 画布完全透明（无底色），输出带 alpha 的 WebM / PNG 序列，可直接叠在实拍画面上。
 * 2. 玻璃质感不依赖 backdrop-filter（渲染时背后是透明像素，模糊无内容），
 *    改用多层半透明白 + 顶部镜面渐变 + 1px 内描边 + 底部内发光叠加模拟。
 * 3. 动效：弹性入场 → 斜向高光扫过 → 文字逐层浮现 → 停留。
 */

const FONT =
  "'PingFang SC','Microsoft YaHei','Helvetica Neue','Segoe UI',Arial,sans-serif";

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};

export const TitleBarGlass = ({
  title = '透明图层 · 视频包装',
  eyebrow = 'CG LIBRARY · 微影 V-ing',
  tag = 'V-ING CG',
  width = 1180,
  height = 232,
  radius = 44,
  tone = 'dark',
  grain = 0.055,
  halo = 0,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // ---- 入场：弹性缩放 + 上移 ----
  const enter = spring({
    frame,
    fps,
    config: {damping: 200, mass: 0.9, stiffness: 110},
  });
  const barOpacity = interpolate(frame, [0, 8], [0, 1], clamp);
  const barY = interpolate(enter, [0, 1], [30, 0]);
  const barScale = interpolate(enter, [0, 1], [0.965, 1]);

  // ---- 斜向高光扫过 ----
  const sweep = interpolate(frame, [24, 86], [-45, 145], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });
  const sweepOpacity = interpolate(
    frame,
    [22, 34, 76, 90],
    [0, 0.85, 0.85, 0],
    clamp
  );

  // ---- 文字分层浮现 ----
  const eyebrowO = interpolate(frame, [10, 24], [0, 1], clamp);
  const eyebrowY = interpolate(frame, [10, 24], [10, 0], clamp);

  const titleO = interpolate(frame, [14, 32], [0, 1], clamp);
  const titleY = interpolate(frame, [14, 32], [24, 0], clamp);
  const titleSpacing = interpolate(frame, [14, 40], [14, 3], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });

  const lineW = interpolate(frame, [22, 48], [0, 168], {
    ...clamp,
    easing: Easing.inOut(Easing.cubic),
  });

  const tagO = interpolate(frame, [38, 54], [0, 1], clamp);
  const tagScale = interpolate(frame, [38, 54], [0.88, 1], clamp);

  // ---- 玻璃层 ----
  // dark：烟熏玻璃（白字在任何亮度的画面上都稳），light：通透磨砂玻璃
  const isDark = tone !== 'light';
  const glass = {
    position: 'absolute',
    inset: 0,
    borderRadius: radius,
    background: isDark
      ? 'linear-gradient(180deg, rgba(255,255,255,0.13) 0%, rgba(26,26,32,0.34) 16%, rgba(14,14,20,0.46) 52%, rgba(6,6,10,0.58) 100%)'
      : 'linear-gradient(180deg, rgba(255,255,255,0.38) 0%, rgba(255,255,255,0.17) 30%, rgba(255,255,255,0.09) 62%, rgba(255,255,255,0.16) 100%)',
  };

  // 底部轻微压暗，让白字在亮部画面上也有对比（iOS 玻璃在浅色内容上会加深）
  const scrim = {
    position: 'absolute',
    inset: 0,
    borderRadius: radius,
    background: isDark
      ? 'linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.14) 100%)'
      : 'linear-gradient(180deg, rgba(0,0,0,0) 42%, rgba(0,0,0,0.10) 100%)',
  };

  const innerBorder = {
    position: 'absolute',
    inset: 0,
    borderRadius: radius,
    border: '1px solid rgba(255,255,255,0.58)',
    boxShadow:
      'inset 0 1px 0 rgba(255,255,255,0.85), inset 0 -1px 0 rgba(255,255,255,0.22), inset 0 0 42px rgba(255,255,255,0.10), 0 18px 60px rgba(0,0,0,0.28)',
  };

  return (
    <AbsoluteFill style={{backgroundColor: 'transparent'}}>
      {/* 背后柔光：会在画面上形成一层白雾，默认关闭，需要时用 halo 打开 */}
      {halo > 0 && (
        <AbsoluteFill
          style={{
            opacity: barOpacity * halo,
            background: `radial-gradient(ellipse ${width * 0.62}px ${height * 1.5}px at 50% 50%, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 70%)`,
          }}
        />
      )}

      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          opacity: barOpacity,
          transform: `translateY(${barY}px) scale(${barScale})`,
        }}
      >
        <div
          style={{
            position: 'relative',
            width,
            height,
            borderRadius: radius,
            overflow: 'hidden',
            isolation: 'isolate',
          }}
        >
          {/* 玻璃主体 */}
          <div style={glass} />
          {/* 底部压暗 */}
          <div style={scrim} />
          {/* 底部内发光 */}
          <div
            style={{
              position: 'absolute',
              left: '8%',
              right: '8%',
              bottom: 0,
              height: 2,
              borderRadius: 2,
              background:
                'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0) 100%)',
              opacity: 0.7,
            }}
          />
          {/* 斜向扫光 */}
          <div
            style={{
              position: 'absolute',
              top: '-60%',
              bottom: '-60%',
              width: '26%',
              left: `${sweep}%`,
              transform: 'rotate(18deg)',
              background:
                'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.42) 48%, rgba(255,255,255,0) 100%)',
              filter: 'blur(12px)',
              opacity: sweepOpacity,
            }}
          />
          {/* 细颗粒，避免大面积渐变出现色带 */}
          <svg
            style={{position: 'absolute', inset: 0, opacity: grain, mixBlendMode: 'overlay'}}
            width="100%"
            height="100%"
          >
            <filter id="grain">
              <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="7" />
              <feColorMatrix type="saturate" values="0" />
            </filter>
            <rect width="100%" height="100%" filter="url(#grain)" />
          </svg>
          {/* 内描边压在最上层 */}
          <div style={innerBorder} />

          {/* 文本区 */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              paddingLeft: 64,
              paddingRight: 64,
              fontFamily: FONT,
            }}
          >
            <div
              style={{
                fontSize: 21,
                letterSpacing: 9,
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.82)',
                opacity: eyebrowO,
                transform: `translateY(${eyebrowY}px)`,
                marginBottom: 16,
                textShadow: '0 1px 12px rgba(0,0,0,0.45)',
              }}
            >
              {eyebrow}
            </div>

            <div
              style={{
                fontSize: 74,
                fontWeight: 600,
                letterSpacing: titleSpacing,
                color: '#FFFFFF',
                lineHeight: 1.16,
                opacity: titleO,
                transform: `translateY(${titleY}px)`,
                textShadow:
                  '0 2px 26px rgba(0,0,0,0.50), 0 0 1px rgba(255,255,255,0.9), 0 1px 2px rgba(0,0,0,0.35)',
              }}
            >
              {title}
            </div>

            <div
              style={{
                height: 1,
                width: lineW,
                marginTop: 22,
                background:
                  'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.75) 50%, rgba(255,255,255,0) 100%)',
              }}
            />
          </div>

          {/* 右下角标签 */}
          <div
            style={{
              position: 'absolute',
              right: 34,
              bottom: 28,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 16px',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.16)',
              border: '1px solid rgba(255,255,255,0.42)',
              color: 'rgba(255,255,255,0.88)',
              fontSize: 16,
              letterSpacing: 3,
              fontFamily: FONT,
              opacity: tagO,
              transform: `scale(${tagScale})`,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: 'rgba(255,255,255,0.9)',
                display: 'inline-block',
              }}
            />
            {tag}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
