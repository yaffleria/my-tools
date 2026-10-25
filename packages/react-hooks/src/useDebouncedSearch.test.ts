import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedSearch } from './useDebouncedSearch';
import { useDebouncedValue } from './useDebouncedValue';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A fetcher whose calls resolve only when the test says so. */
function controllable() {
  const calls: { query: string; signal: AbortSignal; resolve: (v: string[]) => void; reject: (e: unknown) => void }[] = [];
  const fetcher = vi.fn(
    (query: string, signal: AbortSignal) =>
      new Promise<string[]>((resolve, reject) => {
        calls.push({ query, signal, resolve, reject });
      }),
  );
  return { calls, fetcher };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useDebouncedValue', () => {
  it('updates only after the value stops changing', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'ab' });
    act(() => vi.advanceTimersByTime(200));
    rerender({ value: 'abc' });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe('a');
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe('abc');
  });
});

describe('useDebouncedSearch', () => {
  it('calls the fetcher once, after the debounce, with the trimmed query', async () => {
    const { calls, fetcher } = controllable();
    const { result, rerender } = renderHook(({ q }) => useDebouncedSearch(q, fetcher), {
      initialProps: { q: '' },
    });
    rerender({ q: 's' });
    rerender({ q: 'se' });
    rerender({ q: ' seoul ' });
    expect(result.current.isDebouncing).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(300));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(calls[0].query).toBe('seoul');
    expect(result.current.status).toBe('loading');

    calls[0].resolve(['Seoul Station']);
    await flush();
    expect(result.current).toMatchObject({ status: 'success', data: ['Seoul Station'], query: 'seoul' });
  });

  it('aborts the previous request and ignores its late result', async () => {
    const { calls, fetcher } = controllable();
    const { result, rerender } = renderHook(({ q }) => useDebouncedSearch(q, fetcher), {
      initialProps: { q: 'seo' },
    });
    act(() => vi.advanceTimersByTime(300));
    rerender({ q: 'seoul' });
    act(() => vi.advanceTimersByTime(300));

    expect(calls).toHaveLength(2);
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(false);

    calls[1].resolve(['new']);
    await flush();
    calls[0].resolve(['old']); // arrives late
    await flush();
    expect(result.current.data).toEqual(['new']);
  });

  it('treats an abort as silence, not an error', async () => {
    const { calls, fetcher } = controllable();
    const { result, rerender } = renderHook(({ q }) => useDebouncedSearch(q, fetcher), {
      initialProps: { q: 'a' },
    });
    act(() => vi.advanceTimersByTime(300));
    rerender({ q: 'ab' });
    act(() => vi.advanceTimersByTime(300)); // new search starts → old one is aborted
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].reject(new DOMException('Aborted', 'AbortError'));
    await flush();
    expect(result.current.status).not.toBe('error');
  });

  it('reports a real failure as error', async () => {
    const { calls, fetcher } = controllable();
    const { result } = renderHook(() => useDebouncedSearch('busan', fetcher));
    act(() => vi.advanceTimersByTime(300));
    calls[0].reject(new Error('500'));
    await flush();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('clears without fetching below minLength, and aborts on unmount', () => {
    const { calls, fetcher } = controllable();
    const { result, rerender, unmount } = renderHook(({ q }) => useDebouncedSearch(q, fetcher, { minLength: 2 }), {
      initialProps: { q: 'jeju' },
    });
    act(() => vi.advanceTimersByTime(300));
    expect(calls).toHaveLength(1);

    rerender({ q: 'j' });
    act(() => vi.advanceTimersByTime(300));
    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(true);
    expect(result.current).toMatchObject({ status: 'idle', data: undefined });

    rerender({ q: 'jeju' });
    act(() => vi.advanceTimersByTime(300));
    unmount();
    expect(calls[1].signal.aborted).toBe(true);
  });

  it('uses the latest fetcher without restarting the search', () => {
    const first = vi.fn(() => new Promise<string[]>(() => {}));
    const second = vi.fn(() => new Promise<string[]>(() => {}));
    const { rerender } = renderHook(({ f }) => useDebouncedSearch('q', f), { initialProps: { f: first } });
    act(() => vi.advanceTimersByTime(300));
    rerender({ f: second });
    act(() => vi.advanceTimersByTime(300));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});
