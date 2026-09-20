import { useCallback, useEffect, useRef } from 'react';

/** 只有当前请求可以提交状态；重新请求、清空或卸载会使旧请求失效。 */
export function useLatestRequest() {
  const version = useRef(0);
  const begin = useCallback(() => ++version.current, []);
  const isCurrent = useCallback((request: number) => request === version.current, []);
  const invalidate = useCallback(() => { version.current++; }, []);
  useEffect(() => invalidate, [invalidate]);
  return { begin, isCurrent, invalidate };
}
