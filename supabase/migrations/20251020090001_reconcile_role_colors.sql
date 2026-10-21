-- Reconcile the two places a role color is stored.
--
-- `roles.color` and `role_color_settings.base_color` both hold "the color of
-- this role", and nothing kept them in step. Live drift before this migration:
--
--   role        roles.color   role_color_settings.base_color
--   admin       #5692ff       #85baff          <-- different
--   supervisor  #7c3aed       #7c3aed
--   soporte     #16a34a       #16a34a
--   auditor     #0ea5e9       (no row)
--
-- `roles` is the source of truth: it is the registry of roles (custom roles
-- live only there), and its rows are newer than the seed in
-- role_color_settings. So this pushes roles.color outward and never the
-- reverse — the direction that cannot lose a role.
--
-- Custom roles are left alone on purpose. role_color_settings is keyed by the
-- three shipped slugs because that is what the message bubbles key off
-- (`role_at_send` is the legacy three-value column). Adding an `auditor` row
-- would be a row nothing reads: a color that looks configured and does nothing.

update public.role_color_settings rcs
set base_color = r.color
from public.roles r
where r.key = rcs.role
  and rcs.base_color is distinct from r.color;

-- Report what changed rather than silently mutating. Running this by hand
-- after the fact returns 0 rows, which is how you know it already applied.
--
--   select rcs.role, r.color, rcs.base_color
--   from role_color_settings rcs join roles r on r.key = rcs.role;