const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// ---------- 常量 ----------
const IGNORE = new Set([
  'README.md', 'README', 'LICENSE',
  '.git', '.github', '.gitignore', '.vscode', '.idea',
  'node_modules', 'dist',
  'package.json', 'package-lock.json',
  'build.js'
]);

const VIEW_ID = 'articleManager.articleTree';

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

function readInfo(dir) {
  const p = path.join(dir, 'info.json');
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const obj = Array.isArray(raw) ? raw[0] : raw;
    return (obj && typeof obj === 'object') ? obj : {};
  } catch {
    return {};
  }
}

function writeInfo(dir, meta) {
  const p = path.join(dir, 'info.json');
  fs.writeFileSync(p, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

function isDirEntry(e) {
  return e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith('.');
}

function hasSubDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some(isDirEntry);
  } catch {
    return false;
  }
}

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function slugify(s) {
  const r = s.trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
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

    const desc = [];
    if (meta.date) desc.push(meta.date);
    if (meta.encrypted) desc.push('🔒');
    this.description = desc.join('  ');

    this.tooltip = new vscode.MarkdownString(
      `**${title}**\n\n` +
      `类型：\`${kind}\`\n\n` +
      (meta.date ? `日期：${meta.date}\n\n` : '') +
      (meta.encrypted ? `🔒 已加密\n\n` : '') +
      `路径：\`${fullPath}\``
    );

    if (kind === 'article') {
      this.iconPath = new vscode.ThemeIcon('file-text');
      this.command = {
        command: 'articleManager.openArticle',
        title: '打开文章',
        arguments: [this]
      };
    } else if (kind === 'mixed') {
      this.iconPath = new vscode.ThemeIcon('book');
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
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

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
    const da = a.meta.date || '';
    const db = b.meta.date || '';
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
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(el) {
    return el;
  }
  getChildren(el) {
    const dir = el ? el.fullPath : getRootDir();
    if (!dir || !fs.existsSync(dir)) return [];
    return scanDir(dir);
  }
}

// ---------- 命令实现 ----------
async function createArticle(node) {
  const root = getRootDir();
  if (!root) return vscode.window.showErrorMessage('未打开工作区');
  const parentDir = node ? node.fullPath : root;

  const title = await vscode.window.showInputBox({
    prompt: '文章标题',
    placeHolder: '例如：我的第一篇文章',
    validateInput: v => (v && v.trim()) ? null : '标题不能为空'
  });
  if (title === undefined) return;

  const folderName = await vscode.window.showInputBox({
    prompt: '文件夹名',
    value: slugify(title),
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
    writeInfo(dir, { title: title.trim(), date: todayStr(), encrypted: false });
  } catch (e) {
    return vscode.window.showErrorMessage('创建失败：' + e.message);
  }

  provider.refresh();

  const doc = await vscode.workspace.openTextDocument(path.join(dir, 'page.md'));
  await vscode.window.showTextDocument(doc);
}

async function createFolder(node) {
  const root = getRootDir();
  if (!root) return vscode.window.showErrorMessage('未打开工作区');
  const parentDir = node ? node.fullPath : root;

  const name = await vscode.window.showInputBox({
    prompt: '文件夹名称',
    placeHolder: '例如：技术笔记',
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
    writeInfo(dir, { title: name.trim(), date: todayStr(), encrypted: false });
  } catch (e) {
    return vscode.window.showErrorMessage('创建失败：' + e.message);
  }
  provider.refresh();
}

async function editInfo(node) {
  if (!node) return;
  const dir = node.fullPath;
  const meta = { ...node.meta };
  const baseName = path.basename(dir);

  const title = await vscode.window.showInputBox({
    prompt: '标题',
    value: meta.title || baseName,
    validateInput: v => (v && v.trim()) ? null : '标题不能为空'
  });
  if (title === undefined) return;

  const date = await vscode.window.showInputBox({
    prompt: '日期 (YYYY-MM-DD)',
    value: meta.date || todayStr(),
    validateInput: v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : '格式应为 YYYY-MM-DD'
  });
  if (date === undefined) return;

  const encPick = await vscode.window.showQuickPick(
    [
      { label: '不加密', value: false },
      { label: '加密（AES-256-GCM）', value: true }
    ],
    { placeHolder: '是否加密' }
  );
  if (!encPick) return;
  const encrypted = encPick.value;

  let password = meta.password || '';
  if (encrypted) {
    const pw = await vscode.window.showInputBox({
      prompt: '加密密码（不会写入 list.json）',
      value: password,
      password: true,
      validateInput: v => (v && v.trim()) ? null : '密码不能为空'
    });
    if (pw === undefined) return;
    password = pw;
  }

  const out = { title: title.trim(), date, encrypted };
  if (encrypted) out.password = password;
  for (const [k, v] of Object.entries(meta)) {
    if (['title', 'date', 'encrypted', 'password'].includes(k)) continue;
    out[k] = v;
  }

  try {
    writeInfo(dir, out);
    provider.refresh();
    vscode.window.showInformationMessage('已保存 info.json');
  } catch (e) {
    vscode.window.showErrorMessage('保存失败：' + e.message);
  }
}

async function renameNode(node) {
  if (!node) return;
  const oldName = path.basename(node.fullPath);
  const newName = await vscode.window.showInputBox({
    prompt: '重命名文件夹',
    value: oldName,
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
  const target = fs.existsSync(pagePath) ? pagePath : path.join(node.fullPath, 'info.json');
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

  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);

  const reg = (name, fn) => vscode.commands.registerCommand(name, fn);

  context.subscriptions.push(
    reg('articleManager.refresh', () => provider.refresh()),
    reg('articleManager.createArticle', node => createArticle(node)),
    reg('articleManager.createFolder', node => createFolder(node)),
    reg('articleManager.editInfo', node => editInfo(node)),
    reg('articleManager.renameNode', node => renameNode(node)),
    reg('articleManager.deleteNode', node => deleteNode(node)),
    reg('articleManager.openArticle', node => openArticle(node)),
    reg('articleManager.revealInOS', node => {
      if (node) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.fullPath));
    }),
    reg('articleManager.runBuild', () => runBuild())
  );

  // 文件变化时自动刷新
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