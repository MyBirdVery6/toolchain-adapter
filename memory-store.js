const fs = require('fs');
const path = require('path');

class MemoryStore {
  constructor(storeDir) {
    this._memoryDir = path.join(storeDir, 'memory');
    if (!fs.existsSync(this._memoryDir)) {
      fs.mkdirSync(this._memoryDir, { recursive: true });
    }
  }

  _filePath(sessionId) {
    return path.join(this._memoryDir, `${sessionId}.json`);
  }

  async _readFile(sessionId) {
    try {
      const raw = await fs.promises.readFile(this._filePath(sessionId), 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async _writeFile(sessionId, data) {
    const filePath = this._filePath(sessionId);
    const tmpPath = filePath + '.tmp';
    const backupPath = filePath + '.bak';
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    // Windows 兼容的三步原子写入:
    // 1. 将当前文件重命名为 .bak（保留备份）
    // 2. 将 .tmp 重命名为正式文件
    // 3. 删除 .bak 备份
    // 如果步骤2失败，可以从 .bak 恢复，避免数据丢失
    try {
      await fs.promises.rename(filePath, backupPath);
    } catch (err) {
      // ENOENT: 原文件不存在（首次写入），这是正常的
      if (err.code !== 'ENOENT') throw err;
    }
    try {
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      // 重命名失败，尝试从备份恢复
      try { await fs.promises.rename(backupPath, filePath); } catch { /* ignore */ }
      throw err;
    }
    // 成功后删除备份
    try { await fs.promises.unlink(backupPath); } catch { /* ignore */ }
  }

  async saveContext(sessionId, contextData) {
    try {
      const existing = await this._readFile(sessionId) || {};
      const merged = {
        ...existing,
        ...contextData,
        facts: existing.facts || [],
        lastUpdated: contextData.timestamp || Date.now(),
      };
      await this._writeFile(sessionId, merged);
    } catch (err) {
      console.warn(`[记忆存储] saveContext 失败 (${sessionId}): ${err.message}`);
    }
  }

  async loadContext(sessionId) {
    try {
      const data = await this._readFile(sessionId);
      if (!data) return null;
      const { facts, lastUpdated, ...context } = data;
      return context;
    } catch (err) {
      console.warn(`[记忆存储] loadContext 失败 (${sessionId}): ${err.message}`);
      return null;
    }
  }

  async saveFacts(sessionId, facts) {
    try {
      const existing = await this._readFile(sessionId) || {};
      existing.facts = facts;
      existing.lastUpdated = Date.now();
      await this._writeFile(sessionId, existing);
    } catch (err) {
      console.warn(`[记忆存储] saveFacts 失败 (${sessionId}): ${err.message}`);
    }
  }

  async loadFacts(sessionId) {
    try {
      const data = await this._readFile(sessionId);
      return data?.facts || [];
    } catch (err) {
      console.warn(`[记忆存储] loadFacts 失败 (${sessionId}): ${err.message}`);
      return [];
    }
  }

  async appendFact(sessionId, fact) {
    try {
      const existing = await this._readFile(sessionId) || {};
      const facts = existing.facts || [];
      facts.push(fact);
      existing.facts = facts;
      existing.lastUpdated = Date.now();
      await this._writeFile(sessionId, existing);
    } catch (err) {
      console.warn(`[记忆存储] appendFact 失败 (${sessionId}): ${err.message}`);
    }
  }

  async listSessions() {
    try {
      const files = await fs.promises.readdir(this._memoryDir);
      return files.filter(f => f.endsWith('.json') && !f.endsWith('.bak.json')).map(f => f.slice(0, -5));
    } catch (err) {
      return [];
    }
  }

  async deleteSession(sessionId) {
    try {
      await fs.promises.unlink(this._filePath(sessionId));
    } catch (err) {
      // Idempotent — ignore ENOENT and other errors
    }
  }

  async cleanup(maxAgeMs) {
    try {
      const sessions = await this.listSessions();
      const now = Date.now();
      let removed = 0;
      for (const sessionId of sessions) {
        const data = await this._readFile(sessionId);
        if (data && (now - data.lastUpdated >= maxAgeMs)) {
          await this.deleteSession(sessionId);
          removed++;
        }
      }
      if (removed > 0) {
        console.log(`[记忆存储] 清理了 ${removed} 个过期会话 (maxAge=${maxAgeMs}ms)`);
      }
      return removed;
    } catch (err) {
      console.warn(`[记忆存储] cleanup 失败: ${err.message}`);
      return 0;
    }
  }
}

module.exports = { MemoryStore };
