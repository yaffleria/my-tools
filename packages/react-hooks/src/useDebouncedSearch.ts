import { useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from './useDebouncedValue';

/**
 * Debounced search with request cancellation.
 *
 * What it guarantees:
 * 1. The fetcher runs only after the query stops changing for `delay` ms.
 * 2. When the query changes, the previous request's `AbortSignal` is aborted,
 *    so a slow old response can never overwrite a newer one (no race condition).
 * 3. Aborts are not errors. A query shorter than `minLength` clears the result
 *    without a request. Unmount aborts whatever is in flight.
 *
 * ```ts
 * const { data, status, error } = useDebouncedSearch(query, (q, signal) =>
 *   axios.get('/api/hotels', { params: { q }, signal }).then((r) => r.data),
 * );
 * ```
 *
 * Pass the `signal` to fetch/axios, otherwise the old request keeps running
 * (the hook still ignores its result).
 */

export type SearchStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseDebouncedSearchOptions {
  /** Milliseconds the query must stay unchanged. Default `300`. */
  delay?: number;
  /** Shorter trimmed queries do not search. Default `1`. */
  minLength?: number;
}

export interface UseDebouncedSearchResult<T> {
  /** Result of the latest finished search. Kept while the next one loads. */
  data: T | undefined;
  status: SearchStatus;
  error: unknown;
  /** The trimmed query the current `data` / `status` belong to. */
  query: string;
  /** `true` while typing is still inside the debounce window. */
  isDebouncing: boolean;
}

export function useDebouncedSearch<T>(
  query: string,
  fetcher: (query: string, signal: AbortSignal) => Promise<T>,
  options: UseDebouncedSearchOptions = {},
): UseDebouncedSearchResult<T> {
  const { delay = 300, minLength = 1 } = options;
  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed, delay);

  const [data, setData] = useState<T | undefined>(undefined);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [error, setError] = useState<unknown>(null);

  // Keep the latest fetcher without restarting the search when its identity changes
  // (callers usually pass an inline arrow function).
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (debounced.length < minLength) {
      setData(undefined);
      setStatus('idle');
      setError(null);
      return;
    }

    const controller = new AbortController();
    setStatus('loading');
    setError(null);

    fetcherRef.current(debounced, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return; // a newer query took over
        setData(result);
        setStatus('success');
      },
      (caught: unknown) => {
        if (controller.signal.aborted) return; // cancelled on purpose, not an error
        setError(caught);
        setStatus('error');
      },
    );

    // Runs before the next search and on unmount.
    return () => controller.abort();
  }, [debounced, minLength]);

  return {
    data,
    status,
    error,
    query: debounced,
    isDebouncing: trimmed !== debounced,
  };
}
