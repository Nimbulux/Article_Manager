const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const IGNORE = new Set([
  'README.md', 'README', 'LICENSE',
  '.git', '.github', '.gitignore', '.vscode', '.idea',
  'node_modules', 'dist',
  'package.json', 'package-lock.json',
  'build.js'
]);

const VIEW_ID = 'articleManager.articleTree';
const MIME = 'application/vnd.code.tree.articleManager';

let provider;

// ---------- 路径 & 工具 ----------
function getRootDir() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const base = folders[0].uri.fsPath;
  const cfg = (vscode.workspace.getConfiguration('articleManager').get('docsDir') || '').trim();
  if (!cfg) return base;
  return path.isAbsolute(cfg) ? cfg : path.join(base, cfg);
}

const pad = n => String(n).padStart(2, '0');

// 生成带时区偏移的 ISO 字符串，如 2026-05-01T10:30:00+08:00
function toLocalIso(d) {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offset) / 60));
  const om = pad(Math.abs(offset) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

function nowIso() {
  return toLocalIso(new Date());
}

// ISO -> <input type="datetime-local"> 值（2026-05-01T10:30）
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// <input type="datetime-local"> 值 -> ISO（含时区）
function localInputToIso(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return toLocalIso(d);
}

function readInfo(dir) {
  const p = path.join(dir, 'info.json');
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const obj = Array.isArray(raw) ? raw[0] : raw;
    return (obj && typeof obj === 'object') ? obj : {};
  } catch { return {}; }
}

// 统一写为 [ {...} ] 格式
function writeInfo(dir, meta) {
  fs.writeFileSync(
    path.join(dir, 'info.json'),
    JSON.stringify([meta], null, 2) + '\n',
    'utf8'
  );
}

// 构造一个结构完整的 info 对象
function buildInfo({ title, excerpt, date, updated, tags, reading_time, encrypted, password }) {
  const out = {
    title: String(title || '').trim(),
    excerpt: String(excerpt || ''),
    date: date || nowIso(),
    updated: updated || nowIso(),
    tags: Array.isArray(tags) ? tags : [],
    reading_time: Number.isFinite(reading_time) ? reading_time : 0,
    encrypted: !!encrypted
  };
  if (out.encrypted && password) out.password = password;
  return out;
}

function isDirEntry(e) {
  return e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.');
}
function hasSubDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).some(isDirEntry); }
  catch { return false; }
}
function slugify(s) {
  const r = s.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').slice(0, 60);
  return r || 'untitled';
}

// ---------- TreeItem ----------
class ArticleItem extends vscode.TreeItem {
  constructor(fullPath, kind, meta, hasPage) {
    const title = (meta.title && String(meta.title)) || path.basename(fullPath);
    const collapsible = kind === 'article'
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed;
    super(title, collapsible);

    this.fullPath = fullPath;
    this.kind = kind;
    this.meta = meta;
    this.hasPage = hasPage;
    this.contextValue = kind;
    this.resourceUri = vscode.Uri.file(fullPath);
    this.id = fullPath;

    const desc = [];
    if (meta.date) desc.push(String(meta.date).slice(0, 10));
    if (meta.encrypted) desc.push('🔒');
    this.description = desc.join('  ');

    this.tooltip = new vscode.MarkdownString(
      `**${title}**\n\n类型：\`${kind}\`\n\n` +
      (meta.excerpt ? `摘要：${meta.excerpt}\n\n` : '') +
      (meta.date ? `日期：${meta.date}\n\n` : '') +
      (Array.isArray(meta.tags) && meta.tags.length ? `标签：${meta.tags.join(', ')}\n\n` : '') +
      (Number.isFinite(meta.reading_time) ? `阅读时长：${meta.reading_time} 分钟\n\n` : '') +
      (meta.encrypted ? `🔒 已加密\n\n` : '') +
      `路径：\`${fullPath}\``
    );

    if (kind === 'article' || kind === 'mixed') {
      this.iconPath = new vscode.ThemeIcon(kind === 'mixed' ? 'book' : 'file-text');
      this.command = {
        command: 'articleManager.openArticle',
        title: '打开文章',
        arguments: [this]
      };
    } else {
      this.iconPath = new vscode.ThemeIcon('folder');
    }
  }
}

// ---------- 扫描 ----------
function scanDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }

  const result = [];
  for (const entry of entries) {
    if (!isDirEntry(entry)) continue;
    const full = path.join(dir, entry.name);
    const hasPage = fs.existsSync(path.join(full, 'page.md'));
    const hasKids = hasSubDirs(full);
    const hasInfo = fs.existsSync(path.join(full, 'info.json'));

    let kind = null;
    if (hasPage && hasKids) kind = 'mixed';
    else if (hasPage) kind = 'article';
    else if (hasKids || hasInfo) kind = 'folder';
    if (!kind) continue;

    result.push(new ArticleItem(full, kind, readInfo(full), hasPage));
  }

  result.sort((a, b) => {
    const da = a.meta.date || '', db = b.meta.date || '';
    if (da && db && da !== db) return db.localeCompare(da);
    if (da && !db) return -1;
    if (!da && db) return 1;
    return String(a.label).localeCompare(String(b.label));
  });
  return result;
}

// ---------- Provider ----------
class ArticleTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() { this._onDidChangeTreeData.fire(); }
  getTreeItem(el) { return el; }
  getChildren(el) {
    const dir = el ? el.fullPath : getRootDir();
    if (!dir || !fs.existsSync(dir)) return [];
    return scanDir(dir);
  }
}

// ---------- 拖拽 ----------
class ArticleDragAndDropController {
  constructor(provider) { this.provider = provider; }
  get dragMimeTypes() { return [MIME]; }
  get dropMimeTypes() { return [MIME]; }

  handleDrag(source, dataTransfer) {
    const items = source.filter(i => i && i.fullPath);
    dataTransfer.set(MIME, new vscode.DataTransferItem(items.map(i => i.fullPath)));
  }

  async handleDrop(target, dataTransfer) {
    const item = dataTransfer.get(MIME);
    if (!item) return;
    const sourcePaths = Array.isArray(item.value) ? item.value : [];
    const root = getRootDir();
    if (!root) return;

    const targetDir = target ? target.fullPath : root;

    for (const srcPath of sourcePaths) {
      if (!fs.existsSync(srcPath)) continue;

      if (targetDir === srcPath || targetDir.startsWith(srcPath + path.sep)) {
        vscode.window.showWarningMessage(`不能移动到自身或子目录：${path.basename(srcPath)}`);
        continue;
      }
      if (path.dirname(srcPath) === targetDir) continue;

      const name = path.basename(srcPath);
      const dest = path.join(targetDir, name);
      if (fs.existsSync(dest)) {
        vscode.window.showWarningMessage(`目标已存在同名：${name}`);
        continue;
      }
      try {
        fs.renameSync(srcPath, dest);
      } catch (e) {
        vscode.window.showErrorMessage(`移动失败：${e.message}`);
      }
    }
    this.provider.refresh();
  }
}

// ---------- 命令：新建子文章 ----------
async function createArticle(node) {
  const root = getRootDir();
  if (!root) return vscode.window.showErrorMessage('未打开工作区');
  const parentDir = node ? node.fullPath : root;

  const title = await vscode.window.showInputBox({
    prompt: '文章标题', placeHolder: '例如：我的第一篇文章',
    validateInput: v => (v && v.trim()) ? null : '标题不能为空'
  });
  if (title === undefined) return;

  const folderName = await vscode.window.showInputBox({
    prompt: '文件夹名', value: slugify(title),
    validateInput: v => {
      if (!v || !v.trim()) return '文件夹名不能为空';
      if (/[\\/:*?"<>|]/.test(v)) return '不能包含 \\ / : * ? " < > |';
      if (fs.existsSync(path.join(parentDir, v))) return '该文件夹已存在';
      return null;
    }
  });
  if (!folderName) return;

  const dir = path.join(parentDir, folderName);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'page.md'), `# ${title.trim()}\n\n`, 'utf8');
    const now = nowIso();
    writeInfo(dir, buildInfo({
      title: title.trim(),
      excerpt: '',
      date: now,
      updated: now,
      tags: [],
      reading_time: 0,
      encrypted: false
    }));
  } catch (e) {
    return vscode.window.showErrorMessage('创建失败：' + e.message);
  }
  provider.refresh();

  const doc = await vscode.workspace.openTextDocument(path.join(dir, 'page.md'));
  await vscode.window.showTextDocument(doc);
}

// ---------- 命令：新建文件夹 ----------
async function createFolder(node) {
  const root = getRootDir();
  if (!root) return vscode.window.showErrorMessage('未打开工作区');
  const parentDir = node ? node.fullPath : root;

  const name = await vscode.window.showInputBox({
    prompt: '文件夹名称', placeHolder: '例如：技术笔记',
    validateInput: v => {
      if (!v || !v.trim()) return '名称不能为空';
      if (/[\\/:*?"<>|]/.test(v)) return '不能包含 \\ / : * ? " < > |';
      if (fs.existsSync(path.join(parentDir, v))) return '该文件夹已存在';
      return null;
    }
  });
  if (!name) return;

  const dir = path.join(parentDir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const now = nowIso();
    writeInfo(dir, buildInfo({
      title: name.trim(),
      excerpt: '',
      date: now,
      updated: now,
      tags: [],
      reading_time: 0,
      encrypted: false
    }));
  } catch (e) {
    return vscode.window.showErrorMessage('创建失败：' + e.message);
  }
  provider.refresh();
}

// ---------- 命令：在此创建本页（folder → mixed） ----------
async function createPageHere(node) {
  if (!node) return;
  if (node.kind !== 'folder') {
    return vscode.window.showInformationMessage('该节点已包含本页内容');
  }
  const dir = node.fullPath;
  const baseName = path.basename(dir);

  const title = await vscode.window.showInputBox({
    prompt: '本页标题', value: node.meta.title || baseName,
    validateInput: v => (v && v.trim()) ? null : '标题不能为空'
  });
  if (title === undefined) return;

  const pagePath = path.join(dir, 'page.md');
  if (!fs.existsSync(pagePath)) {
    fs.writeFileSync(pagePath, `# ${title.trim()}\n\n`, 'utf8');
  }
  const m = node.meta || {};
  const now = nowIso();
  writeInfo(dir, buildInfo({
    title: title.trim(),
    excerpt: m.excerpt || '',
    date: m.date || now,
    updated: now,
    tags: Array.isArray(m.tags) ? m.tags : [],
    reading_time: Number.isFinite(m.reading_time) ? m.reading_time : 0,
    encrypted: !!m.encrypted,
    password: m.password
  }));

  provider.refresh();
  const doc = await vscode.workspace.openTextDocument(pagePath);
  await vscode.window.showTextDocument(doc);
}

// ---------- 命令：编辑信息（Webview 面板） ----------
function buildEditInfoHtml(meta, baseName) {
  const init = {
    title: meta.title || baseName,
    excerpt: meta.excerpt || '',
    date: isoToLocalInput(meta.date) || isoToLocalInput(nowIso()),
    tags: Array.isArray(meta.tags) ? meta.tags.join(', ') : '',
    reading_time: Number.isFinite(meta.reading_time) ? meta.reading_time : 0,
    encrypted: !!meta.encrypted,
    password: meta.password || ''
  };
  const initJson = JSON.stringify(init).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); padding: 20px 24px; color: var(--vscode-foreground); }
  h2 { margin-top: 0; }
  .form-item { margin-bottom: 16px; max-width: 520px; }
  label { display: block; margin-bottom: 6px; font-weight: 600; }
  input[type="text"], input[type="datetime-local"], input[type="password"], input[type="number"], textarea {
    width: 100%; box-sizing: border-box; padding: 6px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #444);
    border-radius: 4px;
    font-family: inherit;
  }
  textarea { resize: vertical; min-height: 64px; }
  button {
    padding: 6px 14px; margin-right: 8px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; cursor: pointer;
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
  }
  .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
  .actions { margin-top: 20px; }
  .inline label { font-weight: normal; display: inline-flex; align-items: center; gap: 6px; }
</style>
</head>
<body>
  <h2>编辑信息</h2>
  <div class="form-item">
    <label>标题</label>
    <input id="title" type="text" />
  </div>
  <div class="form-item">
    <label>摘要</label>
    <textarea id="excerpt"></textarea>
  </div>
  <div class="form-item">
    <label>日期</label>
    <input id="date" type="datetime-local" />
  </div>
  <div class="form-item">
    <label>标签（用英文逗号分隔）</label>
    <input id="tags" type="text" placeholder="测试, 教程" />
  </div>
  <div class="form-item">
    <label>阅读时长（分钟）</label>
    <input id="reading_time" type="number" min="0" step="1" />
  </div>
  <div class="form-item inline">
    <label><input id="encrypted" type="checkbox" /> 加密（AES-256-GCM）</label>
  </div>
  <div class="form-item" id="pw-item">
    <label>密码</label>
    <input id="password" type="password" />
    <div class="hint">密码会写入 info.json，构建时用于加密 page.md</div>
  </div>
  <div class="actions">
    <button id="save">保存</button>
    <button id="cancel" class="secondary">取消</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const init = ${initJson};
    document.getElementById('title').value = init.title || '';
    document.getElementById('excerpt').value = init.excerpt || '';
    document.getElementById('date').value = init.date || '';
    document.getElementById('tags').value = init.tags || '';
    document.getElementById('reading_time').value = init.reading_time;
    document.getElementById('encrypted').checked = !!init.encrypted;
    document.getElementById('password').value = init.password || '';

    function updatePw() {
      document.getElementById('pw-item').style.display =
        document.getElementById('encrypted').checked ? 'block' : 'none';
    }
    document.getElementById('encrypted').addEventListener('change', updatePw);
    updatePw();

    document.getElementById('save').addEventListener('click', () => {
      const title = document.getElementById('title').value.trim();
      if (!title) { alert('标题不能为空'); return; }
      const excerpt = document.getElementById('excerpt').value.trim();
      const date = document.getElementById('date').value;
      const tags = document.getElementById('tags').value
        .split(',').map(s => s.trim()).filter(Boolean);
      const reading_time = parseInt(document.getElementById('reading_time').value, 10) || 0;
      const encrypted = document.getElementById('encrypted').checked;
      const password = document.getElementById('password').value;
      if (encrypted && !password) { alert('加密时必须填写密码'); return; }
      vscode.postMessage({
        type: 'save',
        data: { title, excerpt, date, tags, reading_time, encrypted, password }
      });
    });
    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
  </script>
</body>
</html>`;
}

function editInfo(node) {
  if (!node) return;
  const dir = node.fullPath;
  const meta = { ...node.meta };
  const baseName = path.basename(dir);

  const panel = vscode.window.createWebviewPanel(
    'articleManager.editInfo',
    `编辑信息 - ${meta.title || baseName}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = buildEditInfoHtml(meta, baseName);

  panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'save') {
      const d = msg.data;
      const out = buildInfo({
        title: d.title,
        excerpt: d.excerpt,
        date: localInputToIso(d.date) || nowIso(),
        updated: nowIso(),
        tags: d.tags,
        reading_time: d.reading_time,
        encrypted: d.encrypted,
        password: d.password
      });
      try {
        writeInfo(dir, out);
        provider.refresh();
        vscode.window.showInformationMessage('已保存 info.json');
        panel.dispose();
      } catch (e) {
        vscode.window.showErrorMessage('保存失败：' + e.message);
      }
    } else if (msg.type === 'cancel') {
      panel.dispose();
    }
  });
}

// ---------- 其他命令 ----------
async function renameNode(node) {
  if (!node) return;
  const oldName = path.basename(node.fullPath);
  const newName = await vscode.window.showInputBox({
    prompt: '重命名文件夹', value: oldName,
    validateInput: v => {
      if (!v || !v.trim()) return '不能为空';
      if (/[\\/:*?"<>|]/.test(v)) return '不能包含特殊字符';
      if (v !== oldName && fs.existsSync(path.join(path.dirname(node.fullPath), v))) return '已存在同名文件夹';
      return null;
    }
  });
  if (!newName || newName === oldName) return;
  try {
    fs.renameSync(node.fullPath, path.join(path.dirname(node.fullPath), newName));
    provider.refresh();
  } catch (e) {
    vscode.window.showErrorMessage('重命名失败：' + e.message);
  }
}

async function deleteNode(node) {
  if (!node) return;
  const name = node.meta.title || path.basename(node.fullPath);
  const answer = await vscode.window.showWarningMessage(
    `确定要删除「${name}」吗？`,
    { modal: true, detail: `路径：${node.fullPath}\n此操作不可撤销。` },
    '删除'
  );
  if (answer !== '删除') return;
  try {
    fs.rmSync(node.fullPath, { recursive: true, force: true });
    provider.refresh();
    vscode.window.showInformationMessage(`已删除「${name}」`);
  } catch (e) {
    vscode.window.showErrorMessage('删除失败：' + e.message);
  }
}

async function openArticle(node) {
  if (!node) return;
  const pagePath = path.join(node.fullPath, 'page.md');
  const target = fs.existsSync(pagePath)
    ? pagePath
    : path.join(node.fullPath, 'info.json');
  if (!fs.existsSync(target)) {
    vscode.window.showWarningMessage('未找到 page.md 或 info.json');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
}

function runBuild() {
  const root = getRootDir();
  if (!root) return vscode.window.showErrorMessage('未打开工作区');
  const scriptName = vscode.workspace.getConfiguration('articleManager').get('buildScript') || 'build.js';
  const scriptPath = path.join(root, scriptName);
  if (!fs.existsSync(scriptPath)) {
    return vscode.window.showErrorMessage(`未找到构建脚本：${scriptPath}`);
  }
  let terminal = vscode.window.terminals.find(t => t.name === '文章构建');
  if (!terminal) {
    terminal = vscode.window.createTerminal({ name: '文章构建', cwd: root });
  }
  terminal.show();
  terminal.sendText(`node "${scriptPath}"`);
}

// ---------- 生命周期 ----------
function activate(context) {
  provider = new ArticleTreeProvider();
  const dnd = new ArticleDragAndDropController(provider);

  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: dnd
  });
  context.subscriptions.push(treeView);

  const reg = (name, fn) => vscode.commands.registerCommand(name, fn);

  context.subscriptions.push(
    reg('articleManager.refresh', () => provider.refresh()),
    reg('articleManager.createArticle', node => createArticle(node)),
    reg('articleManager.createFolder', node => createFolder(node)),
    reg('articleManager.createPageHere', node => createPageHere(node)),
    reg('articleManager.editInfo', node => editInfo(node)),
    reg('articleManager.renameNode', node => renameNode(node)),
    reg('articleManager.deleteNode', node => deleteNode(node)),
    reg('articleManager.openArticle', node => openArticle(node)),
    reg('articleManager.revealInOS', node => {
      if (node) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.fullPath));
    }),
    reg('articleManager.runBuild', () => runBuild())
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/{page.md,info.json}');
  watcher.onDidCreate(() => provider.refresh());
  watcher.onDidChange(() => provider.refresh());
  watcher.onDidDelete(() => provider.refresh());
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('articleManager')) provider.refresh();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };