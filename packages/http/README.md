# @my-tools/http

axios 인스턴스에 붙이는 인터셉터 두 가지입니다. 런타임 의존성은 `axios`(1.6 이상, peer)뿐이고, 암호화는 브라우저 내장 Web Crypto만 씁니다.

| 함수 | 한 줄 설명 |
| --- | --- |
| `attachTokenRefresh(client, options)` | 동시에 401이 여러 개 나도 refresh는 한 번, 나머지는 기다렸다가 재시도 |
| `attachEncryption(client, encryptor)` | 요청 본문을 하이브리드(AES-GCM + RSA-OAEP) 암호화하고 응답을 복호화 |
| `createHybridEncryptor({ getPublicKey })` | 위에서 쓰는 암호화기. 인터셉터 없이 직접 써도 됨 |
| `importRsaPublicKey(spkiBase64)`, `cachedPublicKey(load)` | 서버 공개키 불러오기와 한 번만 불러오게 감싸기 |

플레이그라운드의 "토큰 갱신"·"요청 암호화" 페이지에서 가짜 서버로 직접 돌려 볼 수 있습니다.

## 빠른 시작

```ts
// api.ts — 앱 전체가 이 인스턴스 하나를 쓴다
import axios from 'axios';
import {
  attachEncryption,
  attachTokenRefresh,
  cachedPublicKey,
  createHybridEncryptor,
  importRsaPublicKey,
} from '@my-tools/http';

let accessToken = '';

export const api = axios.create({ baseURL: '/api' });

// 1) 새 요청마다 최신 토큰을 붙인다 (직접 작성하는 부분)
api.interceptors.request.use((config) => {
  if (accessToken) config.headers.setAuthorization(`Bearer ${accessToken}`);
  return config;
});

// 2) 토큰 갱신
attachTokenRefresh(api, {
  // ⚠️ api가 아닌 axios로. api로 하면 refresh의 401이 자기 자신을 기다린다.
  refresh: () => axios.post('/api/auth/refresh', null, { withCredentials: true }).then((r) => r.data.accessToken),
  onTokenRefreshed: (token) => { accessToken = token; },
  onRefreshFailed: () => { accessToken = ''; location.assign('/login'); },
});

// 3) (선택) 요청 암호화
attachEncryption(
  api,
  createHybridEncryptor({
    getPublicKey: cachedPublicKey(() =>
      axios.get('/api/crypto/public-key').then((r) => importRsaPublicKey(r.data.spki)),
    ),
  }),
);
```

호출하는 쪽은 아무것도 몰라도 됩니다. `api.post('/reservations', input)`의 `data`는 이미 복호화된 평문입니다.

## attachTokenRefresh

### 옵션

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `refresh` | (필수) | 새 access token을 돌려주는 함수. **같은 인스턴스를 쓰면 안 됨** |
| `onTokenRefreshed` | — | 새 토큰 저장. 기다리던 요청이 재시도하기 전에 실행 |
| `onRefreshFailed` | — | 갱신 실패 시 한 번 실행. 세션 정리·로그인 이동 |
| `shouldRefresh` | `status === 401` | 어떤 실패를 "토큰 만료"로 볼지 |
| `applyToken` | `Authorization: Bearer …` | 재시도 요청에 토큰을 붙이는 방법 |

반환값은 인터셉터를 떼는 함수입니다.

### 보장하는 것

1. 동시에 401이 나도 `refresh()`는 **한 번**만 호출됩니다. 나머지는 같은 Promise를 기다렸다가 새 토큰으로 재시도합니다.
2. 재시도는 요청당 **한 번**까지입니다. 재시도도 401이면 그대로 실패합니다. 그렇지 않으면 refresh → 401 → refresh가 무한히 돕니다.
3. refresh가 실패하면 기다리던 요청이 모두 그 에러로 실패하고, `onRefreshFailed`는 한 번만 실행됩니다.
4. 갱신 전에 옛 토큰으로 나간 요청이 갱신 후에 401로 돌아오면, refresh를 또 하지 않고 이미 받은 토큰으로 재시도합니다.

### 동작 원리 (학습용)

```
/orders 401 ─┐
/me     401 ─┼─ 첫 401: pending = refresh()  ← await 전에 동기적으로 할당
/cart   401 ─┘  나머지: pending이 있으니 같은 Promise를 await (= 큐)
                 │
          refresh 성공 → 셋 다 새 토큰으로 재시도
          refresh 실패 → 셋 다 같은 에러로 reject, onRefreshFailed 1번
```

- **큐 = 공유 Promise.** 흔히 보는 구현은 `isRefreshing` 플래그와 `{resolve, reject}` 배열을 따로 관리합니다. 진행 중인 refresh Promise 하나를 모두가 `await`하는 것과 결과가 같고, 깨울 대상을 잊어버릴 일이 없어 더 짧습니다.
- **할당은 await 전에.** `pending ??= refresh()`를 동기적으로 해야, 한 틱 뒤 도착한 401이 `pending`을 보고 합류합니다. await 뒤에 플래그를 올리면 refresh가 두 번 나갑니다.
- **`pending = null`은 `finally`에서.** 성공이든 실패든 다음 만료 때 새 refresh를 시작할 수 있어야 합니다.
- **재시도 표시는 config에.** axios는 `client(config)`로 다시 보낼 때 config의 문자열 키를 복사하므로 `__myToolsRetried` 같은 표시가 살아남습니다. Symbol 키는 복사되지 않아 쓰지 않습니다.
- **refresh는 별도 인스턴스로.** 같은 인스턴스로 보내면 refresh 자신의 401이 이 인터셉터로 들어와 `pending`(= 자기 자신)을 기다리며 영원히 멈춥니다.

## attachEncryption

### 왜 하이브리드인가

- 프론트 번들에 든 값은 환경변수까지 누구나 볼 수 있습니다. 그래서 클라이언트에는 **비밀키를 두지 않습니다**.
- 요청마다 새 AES-256-GCM 키를 만들어 본문을 암호화하고, 그 AES 키를 서버의 **RSA 공개키**로 감싸 같이 보냅니다. 공개키는 노출돼도 괜찮습니다. 감싼 키는 서버의 비밀키로만 풀 수 있습니다.
- 서버는 같은 AES 키로 응답을 암호화합니다. 그래서 응답은 요청을 보낸 클라이언트만 읽을 수 있습니다.
- 본문에 `nonce`(UUID)와 `ts`(ms)가 들어가므로, 서버는 같은 암호문을 다시 보내는 재전송을 거를 수 있습니다.

> HTTPS를 대신하지 않습니다. 프록시·로그·APM에 평문 본문이 남지 않게 하는 추가 계층입니다.

### 서버와 맞출 규격

```
요청 본문  { key, iv, data }                       (모두 base64)
  key  = RSA-OAEP/SHA-256(서버 공개키, AES 원시키 32바이트)
  iv   = 12바이트 난수
  data = AES-GCM(aesKey, iv, JSON.stringify({ nonce, ts, body }))

응답 본문  { iv, data }
  data = AES-GCM(같은 aesKey, 새 iv, JSON.stringify(응답))
```

Node 서버 쪽 예시는 다음과 같습니다(Express, Web Crypto 동일 API).

```ts
const { webcrypto: { subtle } } = await import('node:crypto');
const b64 = (s: string) => Buffer.from(s, 'base64');

app.post('/api/*', async (req, res, next) => {
  const { key, iv, data } = req.body;
  const raw = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, b64(key));
  const aesKey = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: b64(iv) }, aesKey, b64(data));
  const { nonce, ts, body } = JSON.parse(Buffer.from(plain).toString());
  // nonce 재사용·ts 오래됨 → 거절
  req.body = body;
  res.locals.encryptJson = async (value: unknown) => {
    const respIv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await subtle.encrypt({ name: 'AES-GCM', iv: respIv }, aesKey, Buffer.from(JSON.stringify(value)));
    return { iv: Buffer.from(respIv).toString('base64'), data: Buffer.from(enc).toString('base64') };
  };
  next();
});
```

### 옵션

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `shouldEncrypt` | 본문이 있는 요청 | 어떤 요청을 암호화할지 (`config => boolean`) |

### 토큰 갱신과 같이 쓸 때

등록 순서와 상관없이 동작합니다.

- **재시도는 평문부터 다시 암호화합니다.** 첫 암호화 때 평문을 config에 보관해 두고, 재시도하면 새 AES 키·새 IV·새 nonce로 다시 암호화합니다. 옛 암호문을 그대로 다시 보내면 서버의 재전송 방지에 걸리고, 암호문을 한 번 더 암호화하는 사고도 생깁니다.
- **응답은 한 번만 복호화합니다.** 재시도 응답은 안쪽 체인에서 복호화된 뒤 바깥 체인을 한 번 더 지나가므로, 이미 복호화한 응답은 `WeakSet`으로 건너뜁니다.
- **axios 요청 인터셉터는 등록의 역순으로 실행됩니다.** 직접 인터셉터를 섞을 때 기억해 두세요. 응답 인터셉터는 등록한 순서대로 실행됩니다.

### 주의

- 복호화한 응답이나 평문 본문을 Sentry 같은 모니터링에 넣지 마세요. 암호화한 의미가 없어집니다.
- Web Crypto는 HTTPS(또는 localhost)에서만 동작합니다.

## AI에게 줄 지시문

```text
@my-tools/http를 사용해 axios 인스턴스 하나(api.ts)를 만든다.
- 요청 인터셉터로 최신 access token을 붙이고, attachTokenRefresh로 401을 처리한다.
- refresh 함수는 api가 아닌 기본 axios(또는 인터셉터 없는 별도 인스턴스)로 호출한다.
- onTokenRefreshed에서 토큰 저장, onRefreshFailed에서 세션 정리와 로그인 이동.
- 본문 암호화가 필요하면 attachEncryption + createHybridEncryptor, 공개키는 cachedPublicKey로 한 번만 받는다.
- 서버 규격은 packages/http/README.md의 "서버와 맞출 규격"을 그대로 따른다. 비밀키를 프론트에 두지 않는다.
- 컴포넌트에서는 api.get/post만 쓰고 인터셉터 로직을 반복하지 않는다.
```
