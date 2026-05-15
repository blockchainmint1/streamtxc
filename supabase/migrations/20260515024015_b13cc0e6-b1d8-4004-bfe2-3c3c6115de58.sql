UPDATE public.videos SET view_count = GREATEST(view_count, v.pv)
FROM (VALUES
  ('QmNmVi7G562Ukjdn2pveetLhzSgkv6npC85YoNFknsC9L5', 283),
  ('bafybeigezebvqikgxrcf75j4wholderifyblfekdnqkoe6m67dcqjupr24', 129),
  ('bafybeifx4kdxp22ujn5qgtuc5lentasp46zhuk5fjwesrbctkpwwunzeg4', 84),
  ('bafybeicpbi2nyvqkvwzkadu6225i6g3wkl4zzc2yrnqmgnxnlvz444q74y', 66),
  ('bafybeid3eugaaje5qik74vsjtrdvib3tw7h43n6wy7coywxev2doys4anm', 46),
  ('bafybeigabf6xpqrd6k7lcisndk22spptfawrw3ius35wewaynhkxwouu3y', 41)
) AS v(cid, pv)
WHERE videos.cid = v.cid;