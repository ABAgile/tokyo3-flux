# Projects, members and labels

- Project management uses the existing dialog/controls, not a new component variant.
  Repeated secondary maintenance actions use compact icon buttons on wide layouts with accessible labels and native tooltips; labels return at narrow touch widths.
  This applies to project/sprint/member/label row and panel actions, including lifecycle and destructive actions; create/add primary actions retain visible text.
- Projects and GitLab integration share a single-column Projects maintenance view, with GitLab integration first.
  Its show state displays approved GitLab project chips; `Edit integration` keeps the existing inline approval form.
  Project editing uses its existing dialog.
  The workspace project list uses the plain page layout rather than a `maintenance-section` panel.
  Its compact horizontal filter bar sits below the title with the Assignee select first, the Label select second, a non-expanding accessible case-insensitive name search third, and a right-aligned visible project count.
  Assignee and Label accept several values using the same add-a-filter select, removable chips, OR-within/AND-across and exclusive-empty rules as the planning bar, with a Clear project filters action.
  They list projects holding current non-archived work that matches every active filter, with Unassigned and No labels matching empty values; no-match states are explicit and say whether the search, the filters, or both excluded everything.
- Members have a dedicated Members view where admins can search available GitLab users, add or remove members, change roles, and maintain display names; adding a user defaults the workspace name to the GitLab profile name and shows the stored GitLab subject as a read-only field.
  Listings show the name, optional GitLab username and a color-coded role chip using only the role name, without the subject or permission description; OAuth supplies the signed-in user’s profile, while other numeric members need the server-side read connector; bootstrap, non-GitLab or unavailable identities may not have a GitLab username or avatar.
  Non-admins can review the roster only.
  Workspace labels have a dedicated Labels maintenance view with a compact responsive grid for create/rename/delete and color management.
  Deletion confirms removal from all cards, including archived work.
  Names may use an optional `scope::value` form such as `type::bug` or `priority::high`.
  Item label chips use their chosen palette colors and expose an x removal action; Edit opens their dropdown.
  Form input labels are semibold; control text remains normal-weight.
  Names are plain text, at most 60 bytes.
- Project maintenance rows offer a View scope action that selects the project lens and All open work, while new items inherit that project.
