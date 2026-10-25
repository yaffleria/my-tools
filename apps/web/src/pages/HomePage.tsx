const REPO = 'https://github.com/yaffleria/my-tools';

const ITEMS = [
  {
    hash: '#bridge',
    title: 'WebView 브리지',
    desc: '웹과 앱이 하나의 봉투 형식으로 요청·응답·이벤트를 주고받는다. 준비 신호(handshake)로 "타이밍 이슈"를 막는다.',
    pkg: '@my-tools/webview-bridge',
  },
  {
    hash: '#search',
    title: '디바운스 검색',
    desc: '입력이 멈췄을 때만 요청하고, 이전 요청은 취소해서 race condition을 막는다.',
    pkg: '@my-tools/react-hooks',
  },
  {
    hash: '#camera',
    title: '카메라 촬영',
    desc: 'input capture와 getUserMedia 두 방식. 신분증 가이드, 압축, 카메라 정리.',
    pkg: '@my-tools/mobile-web',
  },
  {
    hash: '#signature',
    title: '전자서명',
    desc: '손가락 서명 패드. 스크롤 막기, 레티나 대응, 주소창 resize에도 서명 유지.',
    pkg: '@my-tools/mobile-web',
  },
];

export function HomePage() {
  return (
    <article className="page">
      <header>
        <h2>배우고, 필요할 때 꺼내 쓰는 프론트엔드 도구</h2>
        <p className="lead">
          각 페이지에서 직접 눌러 보며 배우고, 코드는 패키지 단위로 복사하거나 AI에게 참고시켜 바로 쓸 수 있게
          정리했습니다. 카메라와 서명은 휴대폰으로 열어 보세요.
        </p>
      </header>
      <ul className="tiles">
        {ITEMS.map((item) => (
          <li key={item.hash}>
            <a href={item.hash} className="tile">
              <strong>{item.title}</strong>
              <span>{item.desc}</span>
              <code>{item.pkg}</code>
            </a>
          </li>
        ))}
      </ul>
      <section>
        <h3>꺼내 쓰는 법</h3>
        <ul className="points">
          <li>
            같은 모노레포 안: <code>"@my-tools/react-hooks": "workspace:*"</code>를 의존성에 추가.
          </li>
          <li>
            다른 프로젝트: <code>packages/&lt;이름&gt;/src</code> 폴더를 복사. 모두 외부 런타임 의존성이 없다(React 패키지는 react만 필요).
          </li>
          <li>
            AI에게 맡길 때: 저장소의{' '}
            <a href={`${REPO}/blob/main/AGENTS.md`} target="_blank" rel="noreferrer">
              AGENTS.md
            </a>
            와 각 패키지 README의 "AI에게 줄 지시문"을 붙여 넣기.
          </li>
        </ul>
      </section>
    </article>
  );
}
