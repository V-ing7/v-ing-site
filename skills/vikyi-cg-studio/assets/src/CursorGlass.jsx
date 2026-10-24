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
 * CursorGlass — Bibata Modern Ice 同款的「冰蓝玻璃指针」透明图层
 *
 * 设计原则：
 * 1. 画布完全透明，输出带 alpha 的 WebM，可直接叠在录屏 / CG 动画上。
 * 2. 指针造型参考 Bibata Modern Ice：圆角箭头 + 冰蓝渐变 + 深色描边，
 *    但用矢量重绘，不引用原主题文件。
 * 3. 动效：从右下角滑入 → 悬停微降 → 单击（指针压下 + 双圈涟漪）→ 静止。
 *    不加扫光、不加高光带、不加背后柔光。
 * 4. 尺寸按画布宽度比例计算，1080p / 4K 通用；`size` 是指针高度占画布宽度的比例。
 */

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};

export const CursorGlass = ({
  size = 0.07, // 指针高度 = 画布宽 × 0.07（4K 下约 269px）
  ice = '#8FC8EE',
  shadow = true,
}) => {
  const frame = useCurrentFrame();
  const {width, height, fps} = useVideoConfig();

  // 指针高度（画布宽比例），箭头 viewBox 高 132
  const h = width * size;
  const u = h / 132; // 1 个 viewBox 单位等于多少像素

  // ---- 入场：从右下角滑入 ----
  const enter = spring({frame, fps, config: {damping: 190, mass: 0.85, stiffness: 105}});
  const startX = width * 0.68;
  const startY = height * 0.68;
  const stopX = width * 0.53;
  const stopY = height * 0.47;
  const x = interpolate(enter, [0, 1], [startX, stopX]);
  const y = interpolate(enter, [0, 1], [startY, stopY]);
  const opacity = interpolate(frame, [0, 7], [0, 1], clamp);

  // ---- 单击：压下 - 回弹 ----
  const pressDown = interpolate(frame, [36, 40, 46], [1, 0.9, 1], clamp);

  // ---- 涟漪：两圈错开 ----
  const ripple1 = interpolate(frame, [38, 78], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const ripple1O = interpolate(frame, [38, 50, 78], [0, 0.55, 0], clamp);
  const ripple2 = interpolate(frame, [46, 92], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const ripple2O = interpolate(frame, [46, 58, 92], [0, 0.34, 0], clamp);

  // 命中点：指针尖（viewBox 0,0）位置
  const tipX = x;
  const tipY = y;
  const ringBase = h * 0.55;

  return (
    <AbsoluteFill style={{backgroundColor: 'transparent'}}>
      {/* 单击涟漪 */}
      <svg
        width={width}
        height={height}
        style={{position: 'absolute', inset: 0, opacity}}
        viewBox={`0 0 ${width} ${height}`}
      >
        <circle
          cx={tipX}
          cy={tipY}
          r={ringBase * ripple1}
          fill="none"
          stroke="rgba(255,255,255,0.95)"
          strokeWidth={Math.max(1, u * 3.2)}
          opacity={ripple1O}
        />
        <circle
          cx={tipX}
          cy={tipY}
          r={ringBase * ripple2}
          fill="none"
          stroke={ice}
          strokeWidth={Math.max(1, u * 2.4)}
          opacity={ripple2O}
        />
      </svg>

      {/* 指针本体 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: h * (84 / 132),
          height: h,
          transform: `translate(${x}px, ${y}px) scale(${pressDown})`,
          transformOrigin: '0 0',
          opacity,
          filter: shadow ? `drop-shadow(0 ${u * 10}px ${u * 22}px rgba(0,0,0,0.38))` : 'none',
        }}
      >
        <svg width="100%" height="100%" viewBox="0 0 84 132">
          <defs>
            <linearGradient id="iceBody" x1="0" y1="0" x2="0.3" y2="1">
              <stop offset="0%" stopColor="rgba(255,255,255,0.99)" />
              <stop offset="38%" stopColor="rgba(226,242,254,0.97)" />
              <stop offset="78%" stopColor="rgba(178,220,248,0.95)" />
              <stop offset="100%" stopColor={ice} stopOpacity="0.96" />
            </linearGradient>
            <linearGradient id="iceEdge" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(255,255,255,1)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </linearGradient>
          </defs>

          {/* 箭头主体：圆角 + 深色描边 */}
          <path
            d="M2.4 2.4 L2.4 118 L28.6 92.4 L44.2 130.6 L63.4 122.6 L47.6 84.6 L82.4 84.6 Z"
            fill="url(#iceBody)"
            stroke="rgba(8,18,32,0.94)"
            strokeWidth="5.2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* 左侧冰面高光：一条沿左缘的细白线，代替大面积高光 */}
          <path
            d="M7.6 12 L7.6 104"
            stroke="url(#iceEdge)"
            strokeWidth="3.4"
            strokeLinecap="round"
            opacity="0.85"
          />
          {/* 内描边：玻璃质感的第二层线 */}
          <path
            d="M2.4 2.4 L2.4 118 L28.6 92.4 L44.2 130.6 L63.4 122.6 L47.6 84.6 L82.4 84.6 Z"
            fill="none"
            stroke="rgba(255,255,255,0.55)"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </AbsoluteFill>
  );
};
