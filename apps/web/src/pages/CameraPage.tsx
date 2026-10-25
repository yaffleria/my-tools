import { captureFrame, useCameraStream } from '@my-tools/mobile-web';
import { useEffect, useState } from 'react';
import { Page } from '../components/Page';

function useObjectUrl() {
  const [url, setUrl] = useState<string | null>(null);
  // Release the previous preview URL so it does not leak memory.
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return [url, (blob: Blob | null) => setUrl(blob ? URL.createObjectURL(blob) : null)] as const;
}

function InputCapture() {
  const [url, setBlob] = useObjectUrl();
  return (
    <div className="stack">
      <h3>방법 A. input capture</h3>
      <label className="button">
        기본 카메라 앱으로 촬영
        <input
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(event) => setBlob(event.target.files?.[0] ?? null)}
        />
      </label>
      {url && <img className="preview" src={url} alt="촬영한 사진" />}
    </div>
  );
}

function StreamCapture() {
  const { videoRef, status, start, stop } = useCameraStream({ facingMode: 'environment' });
  const [url, setBlob] = useObjectUrl();
  const [info, setInfo] = useState('');

  const shoot = async () => {
    if (!videoRef.current) return;
    const blob = await captureFrame(videoRef.current, { maxWidth: 1280, quality: 0.8 });
    setBlob(blob);
    setInfo(`${(blob.size / 1024).toFixed(0)}KB JPEG`);
    stop();
  };

  return (
    <div className="stack">
      <h3>방법 B. getUserMedia + canvas</h3>
      {status !== 'live' && (
        <button type="button" onClick={start} disabled={status === 'starting'}>
          {status === 'starting' ? '카메라 켜는 중…' : '카메라 켜기'}
        </button>
      )}
      {status === 'denied' && <p className="alert">권한이 거부됐어요. 방법 A로 촬영해 보세요.</p>}
      {status === 'unsupported' && <p className="alert">이 환경은 getUserMedia를 지원하지 않아요 (HTTPS 필요).</p>}
      {status === 'error' && <p className="alert">카메라를 켜지 못했어요. 다른 앱이 카메라를 쓰고 있는지 확인해 보세요.</p>}

      <div className="camera" hidden={status !== 'live'}>
        <video ref={videoRef} autoPlay playsInline muted />
        <div className="id-guide" aria-hidden="true" />
        <p className="camera-hint">신분증을 테두리 안에 맞춰 주세요</p>
      </div>
      {status === 'live' && (
        <div className="row">
          <button type="button" onClick={shoot}>
            촬영
          </button>
          <button type="button" onClick={stop}>
            취소
          </button>
        </div>
      )}
      {url && (
        <>
          <img className="preview" src={url} alt="캡처한 사진" />
          <p className="muted">압축 결과 {info}. 서버로 보내지 않아요.</p>
        </>
      )}
    </div>
  );
}

export function CameraPage() {
  return (
    <Page
      title="카메라 촬영"
      summary="체크인할 때 신분증을 찍는 화면을 연습합니다. 휴대폰에서 열어 보세요."
      points={[
        'input capture는 가장 간단하고, 카메라 화면을 꾸밀 수는 없다.',
        'getUserMedia는 화면 위에 가이드를 겹칠 때 쓴다. HTTPS에서만 동작한다.',
        '화면을 떠나면 트랙을 stop해서 카메라를 끈다 (useEffect cleanup).',
        'iOS는 video에 playsInline이 없으면 전체 화면으로 튀어나간다.',
        'WebView: Android는 앱이 onShowFileChooser·onPermissionRequest를 구현해야 하고, iOS는 Info.plist 카메라 문구가 필요하다.',
        '신분증은 개인정보: 메모리에서만 다루고 로그·저장소에 남기지 않는다.',
      ]}
      source={[
        { label: 'useCameraStream, captureFrame', path: 'packages/mobile-web/src/camera.ts' },
        { label: '이 페이지', path: 'apps/web/src/pages/CameraPage.tsx' },
      ]}
    >
      <InputCapture />
      <hr />
      <StreamCapture />
    </Page>
  );
}
