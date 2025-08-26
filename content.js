(function() {
    'use strict';

    // --- Selectors & Constants ---
    const SOURCE_PANEL_SELECTOR = '.source-panel';
    const SCROLL_AREA_SELECTOR = '.scroll-area-desktop';
    const SOURCE_ROW_SELECTOR = '.single-source-container';
    const SOURCE_TITLE_SELECTOR = '.source-title';
    const SOURCE_CHECKBOX_SELECTOR = '.select-checkbox input[type="checkbox"]';
    const SOURCE_MORE_BUTTON_SELECTOR = '.source-item-more-button';
    const SOURCE_ICON_SELECTOR = 'mat-icon[class*="-icon-color"]';

    // --- State Management ---
    let state = {
        groups: [], // Holds top-level group IDs
        ungrouped: [],
        filterQuery: '',
    };
    let groupsById = new Map(); // Flat map of ALL group objects for easy lookup
    let sourcesByKey = new Map();
    let keyByElement = new WeakMap();
    let shadowRoot = null;
    const projectId = getProjectId();
    let parentMap = new Map();
    let isSyncingState = false;

    // --- Helper Functions ---
    function waitForElement(selector) { return new Promise(resolve => { if (document.querySelector(selector)) return resolve(document.querySelector(selector)); const observer = new MutationObserver(() => { if (document.querySelector(selector)) { resolve(document.querySelector(selector)); observer.disconnect(); } }); observer.observe(document.body, { childList: true, subtree: true }); }); }
    function getProjectId() { const pathSegments = window.location.pathname.split('/'); const notebookIndex = pathSegments.indexOf('notebook'); if (notebookIndex > -1 && notebookIndex + 1 < pathSegments.length) { return pathSegments[notebookIndex + 1]; } return null; }
    function generateSourceKey(element, index) { const checkbox = element.querySelector(SOURCE_CHECKBOX_SELECTOR); const label = checkbox ? checkbox.getAttribute('aria-label') : ''; const title = label || element.querySelector(SOURCE_TITLE_SELECTOR)?.textContent || ''; let hash = 0; for (let i = 0; i < title.length; i++) { const char = title.charCodeAt(i); hash = ((hash << 5) - hash) + char; hash |= 0; } const baseKey = `source_${hash}`; if (sourcesByKey.has(baseKey)) { return `${baseKey}_${index}`; } return baseKey; }
    function showToast(message) { let toast = shadowRoot.querySelector('.sp-toast'); if (!toast) { toast = document.createElement('div'); toast.className = 'sp-toast'; shadowRoot.appendChild(toast); } toast.textContent = message; toast.classList.add('show'); setTimeout(() => { toast.classList.remove('show'); }, 3000); }

    function buildParentMap() {
        parentMap.clear();
        groupsById.forEach(group => {
            group.children.forEach(child => {
                parentMap.set(child.id || child.key, group.id);
            });
        });
    }

    function areAllAncestorsEnabled(keyOrId) {
        let parentId = parentMap.get(keyOrId);
        while (parentId) {
            const parentGroup = groupsById.get(parentId);
            if (!parentGroup || !parentGroup.enabled) {
                return false;
            }
            parentId = parentMap.get(parentId);
        }
        return true;
    }

    function isSourceEffectivelyEnabled(source) {
        if (!source) return false;
        return source.enabled && areAllAncestorsEnabled(source.key);
    }

    // --- Persistence Functions ---
    function saveState() {
        if (!projectId) return;
        const key = `sourcesPlusState_${projectId}`;
        const enabledMap = {};
        sourcesByKey.forEach((source, key) => { enabledMap[key] = source.enabled; });
        const persistableState = { groups: state.groups, groupsById: Object.fromEntries(groupsById), ungrouped: state.ungrouped, enabledMap: enabledMap };
        chrome.storage.local.set({ [key]: persistableState });
    }

    function loadState(callback) {
        if (!projectId) return callback();
        const key = `sourcesPlusState_${projectId}`;
        chrome.storage.local.get(key, (data) => {
            if (data[key] && data[key].groupsById) {
                state.groups = data[key].groups || [];
                state.ungrouped = data[key].ungrouped || [];
                groupsById = new Map(Object.entries(data[key].groupsById));
                groupsById.forEach(g => {
                    if (g.enabled === undefined) g.enabled = true;
                    if (g.collapsed === undefined) g.collapsed = false;
                });
            }
            buildParentMap();
            callback(data[key]?.enabledMap || {});
        });
    }

    // --- Core Render & Logic ---
    function getGroupEffectiveState(group) {
        const descendantKeys = [];
        const getKeys = (g) => {
            if (!g) return;
            g.children.forEach(c => {
                if (c.type === 'source') descendantKeys.push(c.key);
                else getKeys(groupsById.get(c.id));
            });
        };
        getKeys(group);

        const total = descendantKeys.length;
        const on = descendantKeys.filter(key => {
            return isSourceEffectivelyEnabled(sourcesByKey.get(key));
        }).length;

        // MODIFIED: This function now only returns the counts, not a tri-state value.
        return { on, total };
    }

    function render() {
        if (!shadowRoot) return;
        const listContainer = shadowRoot.querySelector('#sources-list');
        if (!listContainer) return;
        listContainer.innerHTML = '';
        const filterQuery = state.filterQuery.toLowerCase();

        const renderSourceItem = (source) => {
            if (!source || (filterQuery && !source.title.toLowerCase().includes(filterQuery))) return '';
            const isGated = !areAllAncestorsEnabled(source.key);
            return `
                <div class="source-item ${isGated ? 'gated' : ''}" draggable="true" data-source-key="${source.key}">
                    <div class="icon-container ${source.iconColorClass || 'icon-color'}"><span class="google-symbols">${source.iconName}</span></div>
                    <div class="menu-container"><button class="sp-more-button" data-source-key="${source.key}"><span class="google-symbols">more_vert</span></button></div>
                    <div class="title-container">${source.title}</div>
                    <div class="checkbox-container"><input type="checkbox" class="sp-checkbox" data-source-key="${source.key}" ${source.enabled ? 'checked' : ''}></div>
                </div>`;
        };
        
        const renderGroup = (group, level) => {
            const groupElement = document.createElement('div');
            const isGated = !group.enabled || !areAllAncestorsEnabled(group.id);
            groupElement.className = `group-container ${isGated ? 'gated' : ''}`;
            groupElement.dataset.groupId = group.id;
            groupElement.style.paddingLeft = `${level * 20}px`;

            const { on, total } = getGroupEffectiveState(group);
            const childrenHtml = group.collapsed ? '' : group.children.map(child => {
                if (child.type === 'source') return renderSourceItem(sourcesByKey.get(child.key));
                return '';
            }).join('');
            
            // MODIFIED: Replaced the group checkbox with a dedicated toggle switch.
            groupElement.innerHTML = `
                <div class="group-header" draggable="true" data-drag-type="group" data-group-id="${group.id}">
                    <button class="sp-caret ${group.collapsed ? 'collapsed' : ''}" title="${group.collapsed ? 'Expand' : 'Collapse'}"><span class="google-symbols">arrow_drop_down</span></button>
                    <label class="sp-toggle-switch" title="${group.enabled ? 'Disable Group' : 'Enable Group'}">
                        <input type="checkbox" class="sp-group-toggle-checkbox" data-group-id="${group.id}" ${group.enabled ? 'checked' : ''}>
                        <span class="sp-toggle-slider"></span>
                    </label>
                    <span class="group-title">📁 ${group.title}</span>
                    <span class="badge">(${on}/${total})</span>
                    <button class="sp-add-subgroup-button" title="Add Subgroup"><span class="google-symbols">create_new_folder</span></button>
                    <button class="sp-isolate-button" title="Isolate this group"><span class="google-symbols">filter_center_focus</span></button>
                    <button class="sp-edit-button" title="Rename"><span class="google-symbols">edit</span></button>
                </div>
                <div class="group-children">${childrenHtml}</div>`;
            
            if (!group.collapsed) {
                const childrenContainer = groupElement.querySelector('.group-children');
                group.children.forEach(child => {
                    if (child.type === 'group') {
                        const childGroup = groupsById.get(child.id);
                        if (childGroup) childrenContainer.appendChild(renderGroup(childGroup, 0));
                    }
                });
            }
            return groupElement;
        };

        state.groups.forEach(groupId => { const group = groupsById.get(groupId); if (group) listContainer.appendChild(renderGroup(group, 0)); });
        
        if (state.ungrouped.length > 0) {
            const ungroupedHeader = document.createElement('h4');
            ungroupedHeader.className = 'ungrouped-header';
            ungroupedHeader.textContent = 'Ungrouped';
            listContainer.appendChild(ungroupedHeader);
            state.ungrouped.forEach(key => {
                const sourceHtml = renderSourceItem(sourcesByKey.get(key));
                if (sourceHtml) listContainer.insertAdjacentHTML('beforeend', sourceHtml);
            });
        }
    }
    
    // --- Action & Event Handlers ---
    function handleAddNewGroup(parentGroupId = null) {
        const newGroup = { id: `group_${Date.now()}`, title: parentGroupId ? 'New Subgroup' : 'New Group', children: [], enabled: true, collapsed: false };
        groupsById.set(newGroup.id, newGroup);
        if (parentGroupId) {
            const parent = groupsById.get(parentGroupId);
            if (parent) parent.children.push({ type: 'group', id: newGroup.id });
        } else {
            state.groups.push(newGroup.id);
        }
        buildParentMap();
        render();
        saveState();
    }

    function syncSourceToPage(source, desiredState) { if (!source || !source.element) return; const originalCheckbox = source.element.querySelector(SOURCE_CHECKBOX_SELECTOR); if (originalCheckbox && originalCheckbox.checked !== desiredState) { originalCheckbox.click(); } }
    function findParentGroupOfSource(key) { for (const group of groupsById.values()) { if (group.children.some(c => c.type === 'source' && c.key === key)) return group; } return null; }
    function removeSourceFromTree(key) { state.ungrouped = state.ungrouped.filter(k => k !== key); groupsById.forEach(g => { g.children = g.children.filter(c => c.type === 'group' || c.key !== key); }); }
    function removeGroupFromTree(id) { state.groups = state.groups.filter(gid => gid !== id); groupsById.forEach(g => { g.children = g.children.filter(c => c.id !== id); }); }
    function isDescendant(possibleChild, possibleParent) { if (!possibleChild || !possibleParent || possibleChild.id === possibleParent.id) return true; let found = false; const visit = (g) => { if (!g || found) return; g.children.forEach(c => { if (c.type === 'group') { if (c.id === possibleChild.id) found = true; visit(groupsById.get(c.id)); } }); }; visit(possibleParent); return found; }

    function handleInteraction(event) {
        const target = event.target;
        const groupContainer = target.closest('.group-container');
        const groupId = groupContainer?.dataset.groupId;

        if (target.closest('.sp-add-subgroup-button')) { handleAddNewGroup(groupId); return; }
        if (target.closest('.sp-caret')) { const g = groupsById.get(groupId); if (g) { g.collapsed = !g.collapsed; render(); saveState(); } return; }
        if (target.closest('.sp-isolate-button')) {
            const allSourceKeys = Array.from(sourcesByKey.keys());
            const oldEffectiveStates = new Map();
            allSourceKeys.forEach(key => {
                const s = sourcesByKey.get(key);
                if (s) oldEffectiveStates.set(key, isSourceEffectivelyEnabled(s));
            });

            groupsById.forEach(g => { g.enabled = (g.id === groupId); });

            isSyncingState = true;
            allSourceKeys.forEach(key => {
                const s = sourcesByKey.get(key);
                if (s) {
                    const newEffectiveState = isSourceEffectivelyEnabled(s);
                    if (oldEffectiveStates.get(key) !== newEffectiveState) {
                        syncSourceToPage(s, newEffectiveState);
                    }
                }
            });
            isSyncingState = false;

            render();
            saveState();
            showToast(`Isolated "${groupsById.get(groupId).title}"`);
            return;
        }

        // MODIFIED: Logic is now split. This handles the new group toggle switch.
        if (target.classList.contains('sp-group-toggle-checkbox')) {
            const targetGroupId = target.dataset.groupId;
            const group = groupsById.get(targetGroupId);
            if (group) {
                const descendantKeys = [];
                const getKeys = (g) => {
                    if (!g) return;
                    g.children.forEach(c => {
                        if (c.type === 'source') descendantKeys.push(c.key);
                        else getKeys(groupsById.get(c.id));
                    });
                };
                getKeys(group);

                const oldEffectiveStates = new Map();
                descendantKeys.forEach(key => {
                    oldEffectiveStates.set(key, isSourceEffectivelyEnabled(sourcesByKey.get(key)));
                });

                group.enabled = target.checked;

                isSyncingState = true;
                descendantKeys.forEach(key => {
                    const source = sourcesByKey.get(key);
                    const newEffectiveState = isSourceEffectivelyEnabled(source);
                    if (oldEffectiveStates.get(key) !== newEffectiveState) {
                        syncSourceToPage(source, newEffectiveState);
                    }
                });
                isSyncingState = false;
                
                saveState();
                render();
            }
        } 
        // MODIFIED: This now only handles individual source checkboxes.
        else if (target.classList.contains('sp-checkbox')) {
            const sourceKey = target.dataset.sourceKey;
            if (sourceKey) {
                const source = sourcesByKey.get(sourceKey);
                if (source) {
                    source.enabled = target.checked;
                    if (areAllAncestorsEnabled(sourceKey)) {
                        isSyncingState = true;
                        syncSourceToPage(source, source.enabled);
                        isSyncingState = false;
                    }
                    saveState();
                    render();
                }
            }
        }

        const moreButton = target.closest('.sp-more-button');
        if (moreButton) { const key = moreButton.dataset.sourceKey; const source = sourcesByKey.get(key); if (source?.element) { source.element.querySelector(SOURCE_MORE_BUTTON_SELECTOR)?.click(); } }
        const editButton = target.closest('.sp-edit-button');
        if (editButton) { triggerRename(groupContainer); }
    }
    
    function handleOriginalCheckboxChange(event) {
        if (isSyncingState) return;
        const checkbox = event.target;
        const sourceRow = checkbox.closest(SOURCE_ROW_SELECTOR);
        if (!sourceRow) return;
        const key = keyByElement.get(sourceRow);
        if (key) {
            const source = sourcesByKey.get(key);
            if (source && source.enabled !== checkbox.checked) {
                source.enabled = checkbox.checked;
                render();
                saveState();
            }
        }
    }
    function triggerRename(groupContainer) { const groupId = groupContainer.dataset.groupId; const group = groupsById.get(groupId); if (!group) return; const titleSpan = groupContainer.querySelector('.group-title'); const originalTitle = group.title; const input = document.createElement('input'); input.type = 'text'; input.value = originalTitle; titleSpan.innerHTML = '📁 '; titleSpan.appendChild(input); input.focus(); input.select(); const cleanup = () => { input.removeEventListener('blur', handleSave); input.removeEventListener('keydown', handleKey); render(); }; const handleSave = () => { const newTitle = input.value.trim(); if (newTitle) group.title = newTitle; cleanup(); saveState(); }; const handleKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); handleSave(); } else if (e.key === 'Escape') { e.preventDefault(); group.title = originalTitle; cleanup(); } }; input.addEventListener('blur', handleSave); input.addEventListener('keydown', handleKey); }
    function handleDragStart(e) { const sourceTarget = e.target.closest('.source-item'); const groupTarget = e.target.closest('.group-header'); if (sourceTarget) { const key = sourceTarget.dataset.sourceKey; if (key) { e.dataTransfer.setData('application/source-key', key); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => sourceTarget.classList.add('dragging'), 0); } } else if (groupTarget) { const key = groupTarget.dataset.groupId; if (key) { e.dataTransfer.setData('application/group-id', key); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => groupTarget.classList.add('dragging'), 0); } } }
    function handleDragOver(e) { const dropTarget = e.target.closest('.group-container'); if (dropTarget) { e.preventDefault(); dropTarget.classList.add('drag-over'); } }
    function handleDragLeave(e) { const dropTarget = e.target.closest('.group-container'); if (dropTarget) { dropTarget.classList.remove('drag-over'); } }
    function handleDrop(e) { const dropTarget = e.target.closest('.group-container'); if (!dropTarget) return; e.preventDefault(); dropTarget.classList.remove('drag-over'); const sourceKey = e.dataTransfer.getData('application/source-key'); const draggedGroupId = e.dataTransfer.getData('application/group-id'); const targetGroupId = dropTarget.dataset.groupId; const targetGroup = groupsById.get(targetGroupId); if (!targetGroup) return; if (sourceKey) { removeSourceFromTree(sourceKey); targetGroup.children.push({ type: 'source', key: sourceKey }); } else if (draggedGroupId && draggedGroupId !== targetGroupId && !isDescendant(groupsById.get(targetGroupId), groupsById.get(draggedGroupId))) { removeGroupFromTree(draggedGroupId); targetGroup.children.push({ type: 'group', id: draggedGroupId }); } buildParentMap(); render(); saveState(); }
    function handleDragEnd(e) { const draggedItem = shadowRoot.querySelector('.dragging'); if (draggedItem) { draggedItem.classList.remove('dragging'); } }

    // --- Initialization & Observation ---
    function scanAndSyncSources(loadedEnabledMap) {
        const allKnownKeys = new Set();
        groupsById.forEach(g => g.children.forEach(c => { if (c.type === 'source') allKnownKeys.add(c.key); }));
        state.ungrouped.forEach(key => allKnownKeys.add(key));
        sourcesByKey.clear();
        keyByElement = new WeakMap();
        const sourceElements = document.querySelectorAll(SOURCE_ROW_SELECTOR);
        Array.from(sourceElements).forEach((el, index) => {
            const title = el.querySelector(SOURCE_TITLE_SELECTOR)?.textContent.trim() || 'Untitled Source';
            const iconEl = el.querySelector(SOURCE_ICON_SELECTOR);
            const iconName = iconEl?.textContent.trim() || 'article';
            const iconColorClass = Array.from(iconEl?.classList || []).find(cls => cls.endsWith('-icon-color')) || '';
            const key = generateSourceKey(el, index);
            const enabled = (key in loadedEnabledMap) ? loadedEnabledMap[key] : el.querySelector(SOURCE_CHECKBOX_SELECTOR)?.checked || false;
            sourcesByKey.set(key, { key, title, element: el, enabled, iconName, iconColorClass });
            keyByElement.set(el, key);
            if (!allKnownKeys.has(key)) {
                state.ungrouped.push(key);
            }
        });
        
        buildParentMap();
        isSyncingState = true;
        sourcesByKey.forEach(source => {
            syncSourceToPage(source, isSourceEffectivelyEnabled(source));
        });
        isSyncingState = false;
    }

    function handleDomChanges(mutations) { let needsReSync = false; for (const mutation of mutations) { if (mutation.type === 'childList' || mutation.type === 'characterData') { needsReSync = true; break; } } if (needsReSync) { scanAndSyncSources({}); render(); saveState(); } }
    
    function init(sourcePanel) {
        const extensionRoot = document.createElement('div');
        shadowRoot = extensionRoot.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        // MODIFIED: Added styles for the new toggle switch and removed tri-state checkbox styles.
        style.textContent = `
            @font-face { font-family: 'Google Symbols'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/googlesymbols/v342/HhzMU5Ak9u-oMExPeInvcuEmPosC9zyteYEFU68cPrjdKM1XLPTxlGmzczpgWvF1d8Yp7AudBnt3CPar1JFWjoLAUv3G-tSNljixIIGUsC62cYrKiAw.woff2) format('woff2'); }
            .google-symbols { font-family: 'Google Symbols'; font-weight: normal; font-style: normal; font-size: 20px; line-height: 1; letter-spacing: normal; text-transform: none; display: inline-block; white-space: nowrap; word-wrap: normal; direction: ltr; -webkit-font-feature-settings: 'liga'; -webkit-font-smoothing: antialiased; }
            .sp-controls { display: flex; gap: 8px; margin-bottom: 1rem; }
            #sp-search { flex-grow: 1; padding: 8px 12px; border: 1px solid var(--v3-note-editor-border-color, #dde1eb); border-radius: 8px; font-size: 14px; background-color: var(--v2-surface, #f7fbff); color: var(--v2-on-surface, #47484c); }
            .sp-button { border: 1px solid var(--v3-note-editor-border-color, #dde1eb); color: var(--v3-action-button-text-color, #5f6368); background-color: transparent; font-family: 'Google Sans', sans-serif; font-size: 14px; font-weight: 500; border-radius: 999px; padding: 8px 16px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; }
            .sp-button:hover { background-color: rgba(0,0,0,0.05); }
            .sp-checkbox { appearance: none; -webkit-appearance: none; width: 18px; height: 18px; border: 2px solid var(--mat-checkbox-unselected-icon-color, var(--mat-sys-on-surface-variant)); border-radius: 2px; cursor: pointer; position: relative; flex-shrink: 0; }
            .sp-checkbox:checked { background-color: var(--mat-checkbox-selected-icon-color, var(--mat-sys-primary)); border-color: var(--mat-checkbox-selected-icon-color, var(--mat-sys-primary)); }
            .sp-checkbox:checked::before { content: '✓'; display: block; color: var(--mat-checkbox-selected-checkmark-color, white); position: absolute; top: -3px; left: 2px; font-size: 18px; font-weight: bold; }
            .source-item, .group-header { display: flex; align-items: center; padding: 4px; border-radius: 4px; margin: 2px 0; }
            .source-item { cursor: grab; padding-left: 8px; }
            .group-header { font-weight: 500; background-color: #f8f9fa; cursor: grab; }
            .source-item:hover { background-color: #edeffa; }
            .sp-caret { background: none; border: none; cursor: pointer; padding: 0 4px; transition: transform 0.2s; transform: rotate(0deg); color: #5f6368; }
            .sp-caret .google-symbols { font-size: 24px; }
            .sp-caret.collapsed { transform: rotate(-90deg); }
            .icon-container { flex-shrink: 0; margin-right: 8px; display: flex; align-items: center; }
            .menu-container { flex-shrink: 0; margin-right: 8px; visibility: hidden; }
            .source-item:hover .menu-container { visibility: visible; }
            .title-container, .group-title { flex-grow: 1; min-width: 0; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; font-family: 'Google Sans', sans-serif; font-size: 14px; color: var(--v2-on-surface-emphasis, #1f1f1f); }
            .checkbox-container { flex-shrink: 0; margin-left: auto; padding-left: 8px; }
            .sp-more-button, .sp-add-subgroup-button, .sp-isolate-button, .sp-edit-button { background: none; border: none; cursor: pointer; border-radius: 50%; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; padding: 0; color: #5f6368; flex-shrink: 0; }
            .sp-add-subgroup-button, .sp-isolate-button, .sp-edit-button { display: none; margin-left: 4px; }
            .group-header:hover .sp-add-subgroup-button, .group-header:hover .sp-isolate-button, .group-header:hover .sp-edit-button { display: flex; }
            .group-title + .badge { margin-left: auto; }
            .sp-more-button:hover, .sp-add-subgroup-button:hover, .sp-isolate-button:hover, .sp-edit-button:hover { background-color: rgba(0,0,0,0.1); }
            .icon-color { color: #448aef; } .youtube-icon-color { color: #FF0000; } .pdf-icon-color { color: #B30B00; }
            .group-container { margin-bottom: 4px; }
            .source-item.gated, .group-container.gated > .group-children { opacity: 0.6; }
            .group-children { padding-left: 10px; border-left: 1px solid #e0e0e0; margin-left: 21px; }
            .ungrouped-header { margin: 16px 0 4px 4px; color: #666; font-size: 0.9em; font-weight: 500; }
            .source-item.dragging, .group-header.dragging { opacity: 0.5; }
            .group-container.drag-over > .group-header { background-color: #e8f0fe; }
            .sp-toast { visibility: hidden; min-width: 250px; background-color: #333; color: #fff; text-align: center; border-radius: 4px; padding: 16px; position: fixed; z-index: 9999; left: 50%; bottom: 30px; transform: translateX(-50%); font-size: 16px; opacity: 0; transition: opacity 0.3s, visibility 0.3s; }
            .sp-toast.show { visibility: visible; opacity: 1; }
            .badge { font-size: 12px; color: #5f6368; margin-left: 8px; font-weight: 400; flex-shrink: 0; }
            .sp-toggle-switch { position: relative; display: inline-block; width: 34px; height: 20px; margin: 0 8px 0 4px; flex-shrink: 0; }
            .sp-toggle-switch .sp-group-toggle-checkbox { opacity: 0; width: 0; height: 0; }
            .sp-toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 20px; }
            .sp-toggle-slider:before { position: absolute; content: ""; height: 12px; width: 12px; left: 4px; bottom: 4px; background-color: white; transition: .4s; border-radius: 50%; }
            .sp-group-toggle-checkbox:checked + .sp-toggle-slider { background-color: var(--mat-checkbox-selected-icon-color, var(--mat-sys-primary)); }
            .sp-group-toggle-checkbox:checked + .sp-toggle-slider:before { transform: translateX(14px); }
        `;
        shadowRoot.appendChild(style);
        shadowRoot.innerHTML += `<div class="sp-container"><div class="sp-controls"><button id="sp-new-group-btn" class="sp-button">New Group</button><input id="sp-search" placeholder="Filter sources..."></div><div id="sources-list"></div></div>`;
        
        shadowRoot.getElementById('sp-new-group-btn').addEventListener('click', () => handleAddNewGroup());
        shadowRoot.getElementById('sp-search').addEventListener('input', e => { state.filterQuery = e.target.value; render(); });
        const listContainer = shadowRoot.querySelector('#sources-list');
        listContainer.addEventListener('click', handleInteraction);
        listContainer.addEventListener('change', handleInteraction);
        listContainer.addEventListener('dragstart', handleDragStart);
        listContainer.addEventListener('dragover', handleDragOver);
        listContainer.addEventListener('dragleave', handleDragLeave);
        listContainer.addEventListener('drop', handleDrop);
        listContainer.addEventListener('dragend', handleDragEnd);
        
        const panelHeader = sourcePanel.querySelector('.panel-header');
        if (panelHeader) {
            panelHeader.insertAdjacentElement('afterend', extensionRoot);
            document.addEventListener('change', handleOriginalCheckboxChange, true);
            const scrollArea = document.querySelector(SCROLL_AREA_SELECTOR);
            if (scrollArea) {
                const observer = new MutationObserver(handleDomChanges);
                observer.observe(scrollArea, { childList: true, subtree: true, characterData: true });
            }
            loadState((loadedEnabledMap) => { scanAndSyncSources(loadedEnabledMap); render(); });
        }
    }

    // --- Main execution ---
    if (projectId) {
        waitForElement(SOURCE_PANEL_SELECTOR).then(init);
    }
})();
