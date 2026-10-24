import React from 'react';
import {registerRoot, Composition, AbsoluteFill} from 'remotion';
import {TitleBarGlass} from './TitleBarGlass.jsx';
import {CursorGlass} from './CursorGlass.jsx';

const TitleBarPreview = ({bg = '#101014', ...rest}) => (
  <AbsoluteFill style={{backgroundColor: bg}}>
    <TitleBarGlass {...rest} />
  </AbsoluteFill>
);

const CursorPreview = ({bg = '#151518', ...rest}) => (
  <AbsoluteFill style={{backgroundColor: bg}}>
    <CursorGlass {...rest} />
  </AbsoluteFill>
);

const Root = () => {
  return (
    <>
      <Composition
        id="TitleBarGlass"
        component={TitleBarGlass}
        durationInFrames={120}
        fps={30}
        width={3840}
        height={2160}
        defaultProps={{
          title: '透明图层 · 视频包装',
          eyebrow: 'CG LIBRARY · 微影 V-ing',
          tag: 'V-ING CG',
          width: 1180,
          height: 232,
          radius: 44,
          scale: 2,
        }}
      />
      <Composition
        id="TitleBarPreview"
        component={TitleBarPreview}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          title: '透明图层 · 视频包装',
          eyebrow: 'CG LIBRARY · 微影 V-ing',
          tag: 'V-ING CG',
          width: 1180,
          height: 232,
          radius: 44,
          bg: '#101014',
        }}
      />
      <Composition
        id="CursorGlass"
        component={CursorGlass}
        durationInFrames={120}
        fps={30}
        width={3840}
        height={2160}
        defaultProps={{}}
      />
      <Composition
        id="CursorPreview"
        component={CursorPreview}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{bg: '#151518'}}
      />
    </>
  );
};

registerRoot(Root);
