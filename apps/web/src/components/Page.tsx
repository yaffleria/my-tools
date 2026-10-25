import type { ReactNode } from 'react';

const REPO = 'https://github.com/yaffleria/my-tools/blob/main/';

/** Page frame: what you learn, the live demo, and where the code lives. */
export function Page({
  title,
  summary,
  points,
  source,
  children,
}: {
  title: string;
  summary: string;
  points: string[];
  source: { label: string; path: string }[];
  children: ReactNode;
}) {
  return (
    <article className="page">
      <header>
        <h2>{title}</h2>
        <p className="lead">{summary}</p>
      </header>
      <section className="card">{children}</section>
      <section>
        <h3>핵심</h3>
        <ul className="points">
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </section>
      <section>
        <h3>코드</h3>
        <ul className="points">
          {source.map((item) => (
            <li key={item.path}>
              <a href={REPO + item.path} target="_blank" rel="noreferrer">
                {item.label}
              </a>{' '}
              <code>{item.path}</code>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

/** Scrolling message log used by the bridge and search demos. */
export function Log({ lines, empty = '아직 기록이 없어요.' }: { lines: { id: number; text: string; tone?: string }[]; empty?: string }) {
  return (
    <ol className="log" aria-live="polite">
      {lines.length === 0 && <li className="muted">{empty}</li>}
      {lines.map((line) => (
        <li key={line.id} data-tone={line.tone}>
          {line.text}
        </li>
      ))}
    </ol>
  );
}
