/**
 * Proto service-surface extraction and `.http` generation. Pure — unit-checked
 * in proto.selfcheck.ts.
 *
 * Only the service/rpc surface is read (names and stream flags): generated
 * bodies are `{}` stubs, and interpreting protobuf is the engine's job —
 * httpyac loads the very same protos at run time.
 *
 * Scanning is one string/comment-aware pass producing masked text with the
 * same offsets, so braces or the word `rpc` inside string literals and
 * comments cannot forge structure. A naive "strip comments, then count
 * braces" scanner silently drops methods on mundane protos (reproduced during
 * review).
 */
import type { EmittedCollection } from './openapi';

export interface ProtoMethod {
  name: string;
  requestType: string;
  serverStreaming: boolean;
  clientStreaming: boolean;
}

export interface ProtoService {
  /** `package.Service` — the path a GRPC request line targets. */
  fullName: string;
  methods: ProtoMethod[];
}

export interface ProtoSource {
  /** Where the copy lives inside the collection, relative to the `.http`. */
  relPath: string;
  text: string;
}

/**
 * Blank out string literals and comments, preserving offsets and line breaks.
 * Escapes keep strings closed (a `\"` does not end the string).
 */
function mask(text: string): string {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const out: string[] = new Array(src.length);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1] ?? '';
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') out[i] = ' ', i++;
    } else if (c === '/' && next === '*') {
      out[i] = ' ', out[i + 1] = ' ', i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out[i] = src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < src.length) out[i] = ' ', out[i + 1] = ' ', i += 2;
    } else if (c === '"' || c === "'") {
      const quote = c;
      out[i] = ' ';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out[i] = ' ';
          if (i + 1 < src.length) out[i + 1] = src[i + 1] === '\n' ? '\n' : ' ';
          i += 2;
          continue;
        }
        out[i] = src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < src.length) out[i] = ' ';
      i++;
    } else {
      out[i] = c;
      i++;
    }
  }
  return out.join('');
}

const SERVICE_RE = /\bservice\s+([A-Za-z_][\w.]*)\s*\{/g;
const RPC_RE =
  /\brpc\s+([A-Za-z_]\w*)\s*\(\s*(stream)?\s*([\w.]*)\s*\)\s*returns\s*\(\s*(stream)?\s*([\w.]*)\s*\)/g;
const PACKAGE_RE = /\bpackage\s+([\w.]+)\s*;/;

export function parseProtoServices(text: string): ProtoService[] {
  const masked = mask(text);
  const pkg = masked.match(PACKAGE_RE)?.[1];
  const services: ProtoService[] = [];

  for (const match of masked.matchAll(SERVICE_RE)) {
    const bodyStart = match.index! + match[0].length; // just past `{`
    let depth = 1;
    let i = bodyStart;
    while (i < masked.length && depth > 0) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') depth--;
      i++;
    }
    const body = masked.slice(bodyStart, depth === 0 ? i - 1 : i);

    const methods: ProtoMethod[] = [];
    for (const r of body.matchAll(RPC_RE)) {
      methods.push({
        name: r[1],
        requestType: r[3],
        clientStreaming: r[2] === 'stream',
        serverStreaming: r[4] === 'stream',
      });
    }
    services.push({ fullName: pkg ? `${pkg}.${match[1]}` : match[1], methods });
  }
  return services;
}

export interface ProtoEmitOptions {
  /** gRPC target, `host:port` — the GRPC request line carries no scheme. */
  baseUrl?: string;
  /** Emit `# @grpc-reflection` and no `proto <` lines. */
  reflection?: boolean;
  /** Recorded in the generated file's source header. */
  source: string;
}

/** Proto3 has no required fields, so an empty message is a valid request. */
const EMPTY_BODY = '{}';

export function protoToHttp(protos: ProtoSource[], opts: ProtoEmitOptions): EmittedCollection {
  const methods = protos.flatMap((proto) =>
    parseProtoServices(proto.text).flatMap((service) =>
      service.methods.map((method) => ({ target: `${service.fullName}/${method.name}`, requestType: method.requestType })),
    ),
  );
  if (methods.length === 0) {
    throw new Error(`no gRPC methods found in ${protos.map((p) => p.relPath).join(', ') || '(no protos)'}`);
  }

  const vars: Record<string, string> = { grpcHost: opts.baseUrl ?? 'localhost:50051' };
  const names = new Set<string>();
  const blocks = methods.map(({ target, requestType }) => {
    const base = target.replace(/\W/g, '_');
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base}_${n}`; // `_2`, never ` #2`: a space would break `# @name`
    names.add(name);

    return [
      `### ${target}`,
      `# @name ${name}`,
      ...(opts.reflection ? ['# @grpc-reflection'] : []),
      `# request: ${requestType}`,
      `GRPC {{grpcHost}}/${target}`,
      '',
      EMPTY_BODY,
    ].join('\n');
  });

  const protoLines = opts.reflection ? [] : protos.map((p) => `proto < ./proto/${p.relPath}`);
  const head = [`# source: ${opts.source} · gRPC · ${methods.length} methods`, ...protoLines].join('\n');
  return { text: `${[head, ...blocks].join('\n\n')}\n`, vars };
}
