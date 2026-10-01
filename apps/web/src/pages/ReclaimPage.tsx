import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Select, Tag } from 'antd';
import { Input } from 'antd';

import { downloadBlob, downloadText, errorMessage, getPublicMeta, reclaimCards } from '../api/client';
import {
  DELIVER_FORMAT_OPTIONS,
  isZipDeliverFormat,
  selectDeliverFormat,
  type DeliverFormat,
  type PublicMeta,
  type RedeemResponse,
  type RedeemResult,
} from '../api/types';
import { timestampSuffix } from '../utils/format';
import { buildZipBlob, deliverDownloadEntries } from '../utils/zip';
import { parseCards } from './RedeemPage';
import './RedeemPage.css';

const { TextArea } = Input;
const MAX_CARDS = 500;
const DEFAULT_FORMAT: DeliverFormat = 'sub2api';

/**
 * 401 找回。只提交已兑换卡密和交付格式，不接收密码、JSON、邮箱或令牌。
 */
export default function ReclaimPage() {
  const { message } = AntApp.useApp();
  const [meta, setMeta] = useState<PublicMeta | null>(null);
  const [text, setText] = useState('');
  const [format, setFormat] = useState<DeliverFormat>(DEFAULT_FORMAT);
  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState<RedeemResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPublicMeta()
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
        setFormat(selectDeliverFormat(data.formats, data.defaultFormat));
      })
      .catch(() => {
        if (!cancelled) setMeta(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cards = useMemo(() => parseCards(text), [text]);
  const formatOptions = useMemo(() => {
    const formats = meta?.formats ?? [];
    if (formats.length > 0) {
      return formats.map((item) => ({
        value: item.value,
        label: item.label,
        ext: item.ext,
        bundle: item.bundle,
      }));
    }
    return DELIVER_FORMAT_OPTIONS;
  }, [meta]);

  const results: RedeemResult[] = response?.results ?? [];
  const isZipBatch = isZipDeliverFormat(response?.format, formatOptions);
  const hasBatch = isZipBatch
    ? deliverDownloadEntries(results, response?.format ?? format).length > 0
    : Boolean(response?.mergedContent);

  const handleSubmit = useCallback(async () => {
    if (cards.length === 0 || submitting) return;
    if (cards.length > MAX_CARDS) {
      void message.error(`单次最多提交 ${MAX_CARDS} 张卡密`);
      return;
    }
    setSubmitting(true);
    try {
      const data = await reclaimCards({ cards, format });
      setResponse(data);
      void message.success(`找回完成：成功 ${data.summary.success} 张，失败 ${data.summary.failed} 张`);
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }, [cards, format, message, submitting]);

  const downloadAll = useCallback(() => {
    if (!response || !hasBatch) {
      void message.warning('当前没有可下载的结果');
      return;
    }
    if (isZipBatch) {
      const entries = deliverDownloadEntries(results, response.format);
      if (!entries.length) return;
      downloadBlob(buildZipBlob(entries), `cardline-${response.format}-${timestampSuffix()}.zip`);
      return;
    }
    if (!response.mergedContent) return;
    const ext = formatOptions.find((item) => item.value === response.format)?.ext ?? 'json';
    downloadText(response.mergedContent, `cardline-${response.format}-${timestampSuffix()}.${ext}`);
  }, [formatOptions, hasBatch, isZipBatch, message, response, results]);

  return (
    <main className="page__body">
      <div className="shell redeem-body">
        <div className="redeem-grid">
          <div className="redeem-left">
            <div className="eyebrow">CREDENTIAL RECLAIM</div>
            <h1 className="redeem-title">401 找回</h1>
            <p className="redeem-lead">
              只填写已经兑换过的卡密。服务端会刷新原账号凭据并按所选格式重新交付。未兑换的卡密不能在这里找回，原来的交付文件仍在卡密兑换页下载。
            </p>
            <p className="footnote">
              <span className="footnote__mark">+</span>
              不要在这里粘贴密码、JSON、邮箱或令牌。还没换到新凭据时，失败不会改库。已经换到新凭据时，结果里会带上新文件，请马上保存，不要继续使用旧文件。
            </p>
          </div>

          <aside className="console console--sticky redeem-console">
            <div className="console__head">
              <span className="console__eyebrow">RECLAIM</span>
              <span className="console__pill">仅卡密</span>
            </div>
            <h2 className="console__title">刷新并下载</h2>
            <p className="console__subtitle">一次最多 {MAX_CARDS} 张。成功与失败分开显示。</p>
            <label className="console__label" htmlFor="cardline-reclaim-cards">卡密列表</label>
            <TextArea
              id="cardline-reclaim-cards"
              rows={7}
              className="redeem-textarea"
              placeholder={'CARD-XXXXX-XXXXX-XXXXX'}
              value={text}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
            <div style={{ marginTop: 16 }}>
              <span className="console__label">输出格式</span>
              <Select
                style={{ width: '100%' }}
                value={format}
                options={formatOptions}
                onChange={(value: DeliverFormat) => setFormat(value)}
              />
            </div>
            <div className="console__action-row">
              <span className="console__counter">{cards.length} 张有效卡密</span>
              <Button type="primary" loading={submitting} disabled={cards.length === 0} onClick={() => void handleSubmit()}>
                开始找回
              </Button>
            </div>
            {response ? (
              <div style={{ marginTop: 16 }}>
                <Button disabled={!hasBatch} onClick={downloadAll}>下载全部</Button>
                <div style={{ marginTop: 12 }}>
                  {results.map((item) => (
                    <div key={item.card} style={{ marginBottom: 8 }}>
                      <Tag color={item.ok ? 'success' : 'error'}>{item.ok ? '成功' : item.code}</Tag>
                      <span>{item.card}</span>
                      <span> {item.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </main>
  );
}
