// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
// nav - thin re-export of the navigation derived from site.config.js.
// Single source of truth for nav + curation: site.config.js, which in
// turn derives every entry from the @module blocks in src/.

import * as site from "../site.config.js";

export var NAV_GROUPS = site.navGroups();
export var groupForPath = site.groupForPath;
