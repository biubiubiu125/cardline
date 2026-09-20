import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Empty, Input, InputNumber, Spin, Tag, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';

import {
  downloadBlob,
  errorMessage,
  exportPickupText,
  fetchPickup,
  resolvePickup,
} from '../api/client';
import type {
  ImportFile,
  PickupFetchRecordInput,
  PickupRecord,
  PickupResult,
  PickupResolveSummary,
} from '../api/types';
import MailBrowser from '../components/MailBrowser';
import SiteFooter from '../components/SiteFooter';
import { useLatestRequest } from '../hooks/useLatestRequest';
import './PickupPage.css';

const { TextArea } = Input;

/** 服务端单次取件最多 20 条记录（契约 §1.4） */
const FETCH_CHUNK_SIZE = 20;
/** 单文件上限 8MB（契约 §1.3） */
const MAX_FILE_SIZE = 8 * 1024 * 1024;

const TEXTAREA_PLACEHOLDER = [
  'abc@outlook.com----password----client-id----refresh-token',
  'def@outlook.com----password----client-id----refresh-token',
  'CARD-XXXXX-XXXXX-XXXXX',
].join('\n');

const EMPTY_SUMMARY: PickupResolveSummary = { total: 0, complete: 0, incomplete: 0, unknown: 0 };

function pickupInput(record: PickupRecord): PickupFetchRecordInput {
  return { key: record.key, email: record.email, line: record.line, fromCard: record.fromCard };
}

type PickupPhase = 'idle' | 'resolving' | 'fetching' | 'done' | 'error';

/**
 * 公共页面 · 邮箱取件。
 */
export default function PickupPage() {
  const { message } = AntApp.useApp();
  const { begin, isCurrent, invalidate } = useLatestRequest();

  const [input, setInput] = useState('');
  const [files, setFiles] = useState<ImportFile[]>([]);
  const fileReadVersion = useRef(0);
  useEffect(() => () => { fileReadVersion.current++; }, []);

  const [records, setRecords] = useState<PickupRecord[]>([]);
  const [summary, setSummary] = useState<PickupResolveSummary>(EMPTY_SUMMARY);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [resolved, setResolved] = useState(false);

  const [phase, setPhase] = useState<PickupPhase>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<PickupResult[]>([]);
  const [maxMessages, setMaxMessages] = useState<number>(10);
  const [exporting, setExporting] = useState(false);

  const completeRecords = useMemo(() => records.filter((item) => item.complete), [records]);
  const incompleteRecords = useMemo(() => records.filter((item) => !item.complete), [records]);

  const runSummary = useMemo(() => {
    const success = results.filter((item) => item.ok).length;
    const banned = results.filter((item) => item.banned).length;
    const withCredits = results.filter(
      (item) => typeof item.credits === 'number' && item.credits > 0,
    ).length;
    return { success, failed: results.length - success, banned, withCredits };
  }, [results]);

  const handleResolve = useCallback(async () => {
    if (!input.trim() && files.length === 0) {
      void message.warning('请粘贴账号信息或上传文件');
      return;
    }

    const request = begin();
    setPhase('resolving');
    try {
      const data = await resolvePickup({
        input: input.trim() ? input : undefined,
        files: files.length > 0 ? files : undefined,
      });
      if (!isCurrent(request)) return;
      setRecords(data.records ?? []);
      setSummary(data.summary ?? EMPTY_SUMMARY);
      setUnknown(data.unknown ?? []);
      setResolved(true);
      setResults([]);
      setProgress({ done: 0, total: 0 });
      setPhase('idle');
      void message.success(`解析完成：共 ${data.summary?.total ?? 0} 个账号`);
    } catch (error) {
      if (!isCurrent(request)) return;
      setPhase('error');
      void message.error(errorMessage(error));
    }
  }, [begin, files, input, isCurrent, message]);

  const resetResults = useCallback(() => {
    invalidate();
    setRecords([]);
    setSummary(EMPTY_SUMMARY);
    setUnknown([]);
    setResolved(false);
    setResults([]);
    setProgress({ done: 0, total: 0 });
    setPhase('idle');
    setExporting(false);
  }, [invalidate]);

  const handleFiles = useCallback(
    async (incoming: File[]) => {
      const version = fileReadVersion.current;
      for (const file of incoming) {
        if (file.size > MAX_FILE_SIZE) {
          void message.error(`${file.name} 超过 8MB 限制`);
          continue;
        }
        try {
          const content = await file.text();
          if (version !== fileReadVersion.current) return;
          resetResults();
          setFiles((previous) =>
            previous.some((item) => item.name === file.name)
              ? previous
              : [...previous, { name: file.name, content }],
          );
        } catch {
          if (version !== fileReadVersion.current) return;
          void message.error(`${file.name} 读取失败`);
        }
      }
    },
    [message, resetResults],
  );

  const handleClear = useCallback(() => {
    fileReadVersion.current++;
    resetResults();
    setInput('');
    setFiles([]);
  }, [resetResults]);

  const handleFetch = useCallback(async () => {
    if (completeRecords.length === 0) {
      void message.warning('没有凭据完整的账号可以取件');
      return;
    }

    const chunks: PickupRecord[][] = [];
    for (let index = 0; index < completeRecords.length; index += FETCH_CHUNK_SIZE) {
      chunks.push(completeRecords.slice(index, index + FETCH_CHUNK_SIZE));
    }

    const request = begin();
    setPhase('fetching');
    setResults([]);
    setProgress({ done: 0, total: completeRecords.length });

    const collected: PickupResult[] = [];

    for (const chunk of chunks) {
      if (!isCurrent(request)) return;
      const payloadRecords = chunk.map(pickupInput);

      try {
        const data = await fetchPickup({ records: payloadRecords, maxMessages });
        collected.push(...(data.results ?? []));
      } catch (error) {
        const reason = errorMessage(error);
        chunk.forEach((record) => {
          collected.push({
            key: record.key,
            email: record.email,
            ok: false,
            error: reason,
            banned: false,
            banReason: null,
            banKeywords: [],
            credits: null,
            creditsBalance: null,
            latestCode: null,
            accountId: record.accountId,
            cardKey: record.fromCard,
            fetchedAt: new Date().toISOString(),
            messages: [],
          });
        });
      }

      if (!isCurrent(request)) return;
      setResults([...collected]);
      setProgress({ done: collected.length, total: completeRecords.length });
    }

    setPhase('done');
    const failed = collected.filter((item) => !item.ok).length;
    void message.success(`取件完成：成功 ${collected.length - failed} 个，失败 ${failed} 个`);
  }, [begin, completeRecords, isCurrent, maxMessages, message]);

  const handleExport = useCallback(async () => {
    if (records.length === 0) {
      void message.warning('没有可导出的账号');
      return;
    }

    const request = begin();
    setExporting(true);
    try {
      const { blob, filename } = await exportPickupText({
        records: completeRecords.map(pickupInput),
        kind: 'line',
      });
      if (!isCurrent(request)) return;
      downloadBlob(blob, filename || 'pickup-export.txt');
      void message.success('导出已开始');
    } catch (error) {
      if (isCurrent(request)) void message.error(errorMessage(error));
    } finally {
      if (isCurrent(request)) setExporting(false);
    }
  }, [begin, completeRecords, isCurrent, message, records.length]);

  const phasePill = (() => {
    if (phase === 'fetching') {
      return {
        className: 'console__pill console__pill--busy',
        label: `取件中 ${progress.done}/${progress.total}`,
      };
    }
    if (phase === 'resolving') {
      return { className: 'console__pill console__pill--busy', label: '解析中' };
    }
    if (phase === 'error') {
      return { className: 'console__pill console__pill--danger', label: '错误' };
    }
    if (phase === 'done') {
      return { className: 'console__pill', label: '完成' };
    }
    return { className: 'console__pill console__pill--idle', label: '就绪' };
  })();

  return (
    <>
      <main className="page__body">
        <div className="shell pickup-body">
          <div className="eyebrow">MAILBOX PICKUP</div>
          <h1 className="pickup-title">邮箱取件</h1>
          <p className="pickup-lead">
            输入卡密或 <code className="mono">邮箱----密码----clientid----refresh_token</code>{' '}
            凭据行取件；支持粘贴、上传 txt / sub2api JSON。
          </p>

          <div className="pickup-grid">
            {/* ----------------------------- 左栏 ----------------------------- */}
            <section className="pickup-panel">
              <div className="pickup-panel__head">
                <h2 className="pickup-panel__title">取件账号</h2>
                <span className="pickup-panel__meta">
                  {records.length > 0 ? `已解析 ${records.length} 条` : '等待输入'}
                </span>
              </div>

              <TextArea
                rows={8}
                className="pickup-textarea"
                spellCheck={false}
                placeholder={TEXTAREA_PLACEHOLDER}
                value={input}
                onChange={(event) => {
                  resetResults();
                  setInput(event.target.value);
                }}
              />

              <div className="pickup-controls">
                <Upload
                  multiple
                  showUploadList={false}
                  accept=".txt,.json,.jsonl"
                  beforeUpload={(file) => {
                    resetResults();
                    void handleFiles([file]);
                    return false;
                  }}
                >
                  <Button icon={<UploadOutlined />}>选择文件</Button>
                </Upload>

                <Button
                  type="primary"
                  loading={phase === 'resolving'}
                  disabled={phase === 'fetching' || exporting}
                  onClick={() => {
                    void handleResolve();
                  }}
                >
                  解析
                </Button>

                <Button onClick={handleClear}>清空</Button>
              </div>

              {files.length > 0 ? (
                <div className="pickup-files">
                  {files.map((file) => (
                    <div className="import-file-row" key={file.name}>
                      <span className="import-file-row__name" title={file.name}>
                        {file.name}
                      </span>
                      <span className="import-file-row__size">
                        {(file.content.length / 1024).toFixed(1)} KB
                      </span>
                      <Button
                        type="link"
                        size="small"
                        onClick={() => {
                          resetResults();
                          setFiles((previous) => previous.filter((item) => item.name !== file.name));
                        }}
                      >
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}

              {resolved ? (
                <div className="pickup-summary-line">
                  <span>
                    {summary.total} 个账号 · 凭据完整 {summary.complete} · 缺失 {summary.incomplete}
                  </span>
                  {summary.unknown > 0 ? <span>未识别 {summary.unknown} 行</span> : null}
                </div>
              ) : null}

              {incompleteRecords.length > 0 ? (
                <div className="pickup-hint pickup-hint--danger">
                  <div className="pickup-hint__title">以下账号缺少取件凭据</div>
                  <ul className="pickup-hint__list">
                    {incompleteRecords.map((record) => (
                      <li key={record.key}>
                        <span className="mono">{record.email || record.key}</span>
                        <span> · {record.error ?? '凭据不完整'}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {unknown.length > 0 ? (
                <div className="pickup-hint">
                  <div className="pickup-hint__title">未识别的输入行</div>
                  <ul className="pickup-hint__list">
                    {unknown.slice(0, 12).map((item, index) => (
                      <li key={`${item}-${index}`}>
                        <span className="mono">{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="pickup-records cardline-scroll">
                {records.length === 0 ? (
                  <div className="empty-block">
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="粘贴账号信息后点击「解析」"
                    />
                  </div>
                ) : (
                  records.map((record, index) => (
                    <div
                      className={`pickup-record${record.complete ? '' : ' pickup-record--invalid'}`}
                      key={`${record.key}-${index}`}
                    >
                      <span className="pickup-record__index">{index + 1}</span>
                      <div className="pickup-record__body">
                        <div className="pickup-record__head">
                          <span className="pickup-record__email ellipsis" title={record.email}>
                            {record.email || record.key}
                          </span>
                          <span className="pickup-record__tags">
                            <Tag style={{ margin: 0 }}>{record.label}</Tag>
                            {record.fromCard ? (
                              <Tag
                                color={record.credits && record.credits > 0 ? 'blue' : 'orange'}
                                style={{ margin: 0 }}
                              >
                                {record.credits && record.credits > 0
                                  ? `${record.credits} 额度`
                                  : '待定档'}
                              </Tag>
                            ) : null}
                          </span>
                        </div>
                        {record.fromCard ? (
                          <div className="pickup-record__card mono ellipsis" title={record.fromCard}>
                            {record.fromCard}
                          </div>
                        ) : null}
                        {!record.complete && record.error ? (
                          <div className="pickup-record__error">{record.error}</div>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* --------------------------- 右栏：控制台 --------------------------- */}
            <aside className="console console--sticky pickup-console">
              <div className="console__head">
                <span className="console__eyebrow">PICKUP CONSOLE</span>
                <span className={phasePill.className}>
                  <span className="status-dot__dot" aria-hidden="true" />
                  {phasePill.label}
                </span>
              </div>

              <h2 className="console__title">开始取件</h2>
              <p className="console__subtitle">
                官方直连 Outlook 取最新邮件，自动提取验证码、额度与封禁关键词。
              </p>

              <div className="console__field-grid">
                <div>
                  <span className="console__label">取件数量</span>
                  <div className="pickup-readonly">{records.length} 个账号</div>
                </div>
                <div>
                  <span className="console__label">每箱邮件数</span>
                  <InputNumber
                    style={{ width: '100%' }}
                    min={1}
                    max={50}
                    precision={0}
                    value={maxMessages}
                    onChange={(value) => setMaxMessages(typeof value === 'number' ? value : 10)}
                  />
                </div>
              </div>

              <div className="pickup-actions">
                <Button
                  type="primary"
                  className="console__primary"
                  loading={phase === 'fetching'}
                  disabled={completeRecords.length === 0 || phase === 'fetching'}
                  onClick={() => {
                    void handleFetch();
                  }}
                >
                  开始取件
                </Button>
                <Button
                  disabled={completeRecords.length === 0 || phase === 'fetching'}
                  onClick={() => {
                    void handleFetch();
                  }}
                >
                  重新取件
                </Button>
                <Button
                  loading={exporting}
                  disabled={completeRecords.length === 0 || phase === 'fetching' || phase === 'resolving'}
                  onClick={() => {
                    void handleExport();
                  }}
                >
                  导出可取件账号
                </Button>
              </div>

              {phase === 'fetching' ? (
                <div className="pickup-progress">
                  <Spin size="small" />
                  <span>
                    正在取件 {progress.done} / {progress.total}
                  </span>
                </div>
              ) : null}

              <div className="console__empty pickup-summary-box">
                {results.length === 0
                  ? '取件结果会按账号展示验证码、额度与封禁检测结果。'
                  : `成功 ${runSummary.success} · 失败 ${runSummary.failed} · 已封禁 ${runSummary.banned} · 命中额度 ${runSummary.withCredits}`}
              </div>
            </aside>
          </div>

          {results.length > 0 ? <MailBrowser results={results} loading={phase === 'fetching'} /> : null}
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
