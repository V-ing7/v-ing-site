import React from 'react';
import {AbsoluteFill} from 'remotion';
import {TitleBarGlass} from './TitleBarGlass.jsx';

/**
 * 测试用画布：把透明标题条垫在不同亮度的背景上，
 * 检查在暗部 / 中间调 / 高光画面上是否都还看得清。不用于交付。
 */
export const TitleBarPreview = ({bg = '#101014', ...rest}) => {
  return (
    <AbsoluteFill style={{backgroundColor: bg}}>
      <TitleBarGlass {...rest} />
    </AbsoluteFill>
  );
};
