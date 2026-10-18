import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getLiveFeedFreshness } from "./livestream.functions";

/** True once the live feed is carrying THIS stream (not the last one's leftovers). */
export function useLiveFeedFresh(streamId: string | null | undefined, enabled: boolean) {
  const fn = useServerFn(getLiveFeedFreshness);
  const q = useQuery({
    queryKey: ["live-fresh", streamId],
    queryFn: () => fn({ data: { streamId: streamId! } }),
    enabled: !!streamId && enabled,
    refetchInterval: (query) => (query.state.data?.fresh ? 30_000 : 4_000),
  });
  return !!q.data?.fresh;
}
