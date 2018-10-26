/**
 * Module dependencies.
 */

const debug = require('debug')('koa-send')
const resolvePath = require('resolve-path')
const createError = require('http-errors')
const assert = require('assert')
const fs = require('mz/fs')

const {
  normalize,
  basename,
  extname,
  resolve,
  parse,
  sep
} = require('path')

/**
 * Expose `send()`.
 */

module.exports = send

/**
 * Send file at `path` with the
 * given `options` to the koa `ctx`.
 *
 * @param {Context} ctx
 * @param {String} path
 * @param {Object} [opts]
 * @return {Function}
 * @api public
 */

// 1、参数path校验
// 2、配置opts初始化
// 3、accept encoding处理
// 4、404、500处理
// 5、缓存头处理
// 6、流响应
async function send (ctx, path, opts = {}) {
  // 参数校验
  assert(ctx, 'koa context required')
  assert(path, 'pathname required')

  // options 配置
  debug('send "%s" %j', path, opts)
  const root = opts.root ? normalize(resolve(opts.root)) : ''
  const trailingSlash = path[path.length - 1] === '/'
  path = path.substr(parse(path).root.length)
  const index = opts.index
  const maxage = opts.maxage || opts.maxAge || 0
  const immutable = opts.immutable || false
  const hidden = opts.hidden || false
  const format = opts.format !== false
  const extensions = Array.isArray(opts.extensions) ? opts.extensions : false
  const brotli = opts.brotli !== false
  const gzip = opts.gzip !== false
  const setHeaders = opts.setHeaders

  if (setHeaders && typeof setHeaders !== 'function') {
    throw new TypeError('option setHeaders must be function')
  }

  // normalize path
  path = decode(path)

  if (path === -1) return ctx.throw(400, 'failed to decode')

  // index file support
  if (index && trailingSlash) path += index

  path = resolvePath(root, path)

  // hidden file support, ignore
  if (!hidden && isHidden(root, path)) return

  // accept encoding处理
  // 根据请求头Accept-Encoding进行处理，如果用户浏览器支持br或者gzip的压缩方式
  // 会判断是否存在br或者gz格式文件，如果存在会优先响应br或者gz文件
  let encodingExt = ''
  // serve brotli file when possible otherwise gzipped file when possible
  if (ctx.acceptsEncodings('br', 'identity') === 'br' && brotli && (await fs.exists(path + '.br'))) {
    path = path + '.br'
    ctx.set('Content-Encoding', 'br')
    ctx.res.removeHeader('Content-Length')
    encodingExt = '.br'
  } else if (ctx.acceptsEncodings('gzip', 'identity') === 'gzip' && gzip && (await fs.exists(path + '.gz'))) {
    path = path + '.gz'
    ctx.set('Content-Encoding', 'gzip')
    ctx.res.removeHeader('Content-Length')
    encodingExt = '.gz'
  }

  if (extensions && !/\.[^/]*$/.exec(path)) {
    const list = [].concat(extensions)
    for (let i = 0; i < list.length; i++) {
      let ext = list[i]
      if (typeof ext !== 'string') {
        throw new TypeError('option extensions must be array of strings or false')
      }
      if (!/^\./.exec(ext)) ext = '.' + ext
      if (await fs.exists(path + ext)) {
        path = path + ext
        break
      }
    }
  }

  // stat
  // 404 500 状态处理
  // 会做文件查找，如果不存在文件，或者文件查找异常，则进行404或者500的响应
  let stats
  try {
    stats = await fs.stat(path)

    // Format the path to serve static file servers
    // and not require a trailing slash for directories,
    // so that you can do both `/directory` and `/directory/`
    if (stats.isDirectory()) {
      if (format && index) {
        path += '/' + index
        stats = await fs.stat(path)
      } else {
        return
      }
    }
  } catch (err) {
    const notfound = ['ENOENT', 'ENAMETOOLONG', 'ENOTDIR']
    if (notfound.includes(err.code)) {
      throw createError(404, err)
    }
    err.status = 500
    throw err
  }

  if (setHeaders) setHeaders(ctx.res, path, stats)

  // stream
  // 缓存头处理
  // 设置协商缓存Last-Modified和强制缓存Cache-Control，不过这里面有一个之前没遇到的知识点,设置的Cache-Control会有类似max-age=10000
  // immutable的值，immutable表示永不改变，浏览器永不需要请求资源，这个感觉可以配合带hash或者版本号的资源使用
  ctx.set('Content-Length', stats.size)
  if (!ctx.response.get('Last-Modified')) ctx.set('Last-Modified', stats.mtime.toUTCString())
  if (!ctx.response.get('Cache-Control')) {
    const directives = ['max-age=' + (maxage / 1000 | 0)]
    if (immutable) {
      directives.push('immutable')
    }
    ctx.set('Cache-Control', directives.join(','))
  }
  if (!ctx.type) ctx.type = type(path, encodingExt)
  
  
  // 流处理
  ctx.body = fs.createReadStream(path)

  return path
}

/**
 * Check if it's hidden.
 */

function isHidden (root, path) {
  path = path.substr(root.length).split(sep)
  for (let i = 0; i < path.length; i++) {
    if (path[i][0] === '.') return true
  }
  return false
}

/**
 * File type.
 */

function type (file, ext) {
  return ext !== '' ? extname(basename(file, ext)) : extname(file)
}

/**
 * Decode `path`.
 */

function decode (path) {
  try {
    return decodeURIComponent(path)
  } catch (err) {
    return -1
  }
}
