
const fs = require("fs");
const url = require("url");
const path = require("path");
const crypto = require("crypto");

const pkg = require("./package.json");

const quu = require("quu");
const needle = require("needle");
const mime = require("mime-types");

// optional deps (wish there was a nicer pattern)
const cheerio = (function(){ try { return require("cheerio"); } catch (e) { return null; }})();
const geturi = (function(){ try { return require("get-uri"); } catch (e) { return null; }})();
const iconv = (function(){ try { return require("iconv-lite"); } catch (e) { return null; }})();
const xlsx = (function(){ try { return require("xlsx"); } catch (e) { return null; }})();
const yaml = (function(){ try { return require("yaml"); } catch (e) { return null; }})();
const xsv = (function(){ try { return require("xsv"); } catch (e) { return null; }})();
const xml = (function(){ try { return require("xml2js").parseString; } catch (e) { return null; }})();
const pdf = (function(){ try { return require("pdf.js-extract").PDFExtract; } catch (e) { return null; }})();
const kdl = (function(){ try { return require("kdljs").parse; } catch (e) { return null; }})();
const dw = (function(){ try { return require("dataunwrapper"); } catch (e) { return null; }})();

const scrpr = function(opts){
	if (!(this instanceof scrpr)) return new scrpr(opts);
	const self = this;

	// optionalize opts
	opts = opts||{};

	const q = quu(1);

	self.xsv_opts = {
		csv: { sep: 0x2c, quote: 0x22, escape: 0x5c, header: true },
		ssv: { sep: 0x3b, quote: 0x22, escape: 0x5c, header: true },
		tsv: { sep: 0x9, quote: 0x22, escape: 0x5c, header: true },
	};

	self.needle_opts = {
		user_agent: "Mozilla/5.0 (compatible; "+pkg.name+"/"+pkg.version+"; +https://npmjs.com/package/"+pkg.name+")",
	};
	
	self.concurrency = Math.max((parseInt(opts.concurrency,10)||1),1);
	self.cachedir = !!opts.cachedir ? path.resolve(opts.cachedir) : path.resolve(path.dirname(require.main.filename), ".scrpr-cache");

	q.push(function(done){
		fs.mkdir(self.cachedir, { recursive: true }, function(err){
			q.concurrency = self.concurrency;
		});
	});

	return function(){

		// destructure arguments
		const { u, opt, fn } = Array.from(arguments).reduce(function(a,v){
			switch (typeof v) {
				case "string": a.url = v; break;
				case "object": a.opt = v; break;
				case "function": a.fn = v; break;
			}
			return a;
		},{ fn: function(){} });
		if (!!u && !opt.url) opt.url = u;
		
		opt.stream = !!(opt.stream || false);
		opt.cache = (opt.hasOwnProperty("cache") ? !!opt.cache : true);
		opt.method = opt.method || "get";
		opt.data = opt.data || null;
		opt.needle = opt.needle || {};
		opt.xsv = opt.xsv || {};
		opt.xlsx = opt.xlsx || {};
		opt.pdf = opt.pdf || {};
		opt.successCodes = opt.successCodes || [ 200 ];
		opt.parse = opt.parse || false;
		opt.process = opt.process || opt.postprocess || null;
		opt.preprocess = opt.preprocess || null;
		opt.cacheid = opt.cacheid || self.hash(opt);
		opt.sizechange = !!opt.sizechange;
		opt.metaredirects = (opt.hasOwnProperty("metaredirects")) ? !!opt.metaredirects : ((opt.parse === "dw") || false);
		opt.iconv = opt.iconv || null;
		opt.cooldown = opt.cooldown || false;
				
		const cachefile = path.resolve(self.cachedir, opt.cacheid+".json");

		(function(next){
			if (!opt.cache) return next(null);
			fs.access(cachefile, (fs.constants.F_OK | fs.constants.R_OK), function(e){
				if (e) return next(null);
				fs.readFile(cachefile, function(err, cache){
					if (err) return next(null);
					try {
						cache = JSON.parse(cache);
					} catch (e) {
						return next(null);
					}
					return next(cache);
				});
			});
		})(function(cache){

			// cooldown
			if (opt.cooldown && cache && cache.hasOwnProperty("last") && cache.last+opt.cooldown > Date.now()) return fn(null, false, "cooldown");

			const headers = { ...self.default_headers };
			if (opt.cache && cache && cache.hasOwnProperty("etag") && !!cache.etag) headers["If-None-Match"] = cache.etag;
			else if (opt.cache && cache && cache.hasOwnProperty("modified") && !!cache.modified) headers["If-Modified-Since"] = cache.modified;
			
			const req_opts = {
				...self.needle_opts,
				...opt.needle,
				parse: false,
				headers: {
					...opt.headers,
					...headers
				}
			};
			
			// raw data as stream
			if (opt.stream === true || opt.parser === "stream") return (function(){

				switch (url.parse(opt.url).protocol) {
					case "http:":
					case "https:":
						
						needle.request(opt.method, opt.url, opt.data, req_opts).on("error", function(err){
							return fn(err, false, "error");
						}).on("response", function(resp){

							// ignore response if needle follows a redirect
							if ((!!req_opts.follow||!!req_opts.follow_max) && [301,302,303,307].includes(resp.statusCode)) return;

							if (resp.statusCode === 304) return this.destroy(), fn(null, false, "cache-hit");
							if (req_opts.headers["If-None-Match"] && resp.headers.etag && resp.headers.etag === req_opts.headers["If-None-Match"]) return this.destroy(), fn(null, false, "cache-hit"); // client-side if-none-match, because some servers don't bother
							if (cache && opt.sizechange && resp.headers.hasOwnProperty("content-length") && cache.hasOwnProperty("size") && cache.size === parseInt(resp.headers["content-length"],10)) return this.destroy(), fn(null, false, "cache-hit"); // assume no change if same size because CDNs are weird

							if (opt.successCodes.indexOf(resp.statusCode) <0) return this.destroy(), fn(new Error("Got Status Code "+resp.statusCode), false, "error");

							const stream = (opt.iconv && iconv) ? this.pipe(iconv.decodeStream(opt.iconv)) : this;
							stream.pause();

							// assemble and write cache
							fs.writeFile(cachefile, JSON.stringify({
								last: Date.now(),
								modified: (resp.headers.hasOwnProperty("last-modified") ? resp.headers["last-modified"] : false),
								etag: (resp.headers.hasOwnProperty("etag") ? resp.headers["etag"] : false),
								size: (resp.headers.hasOwnProperty("content-length") ? (parseInt(resp.headers["content-length"],10) || false) : false),
							},null,"\t"), function(err){
								if (err) console.error("Unable to write cache file: %s – %s", cachefile, err);
								stream.resume();
								return fn(null, true, stream, resp);
							});

						});

					break;
					case "ftp:":

						// check if module is available
						if (geturi === null) return fn(new Error("get-uri not available"), false, "error");
						
						// get ftp resource as stream
						geturi(opt.url, { cache: { lastModified: req_opts.headers["If-Modified-Since"], } }, function(err, rs) {
							if (err && err.code === 'ENOTMODIFIED') return fn(null, false, "cache-hit");
							if (err) return fn(err, {}, null);

							const stream = (opt.iconv && iconv) ? rs.pipe(iconv.decodeStream(opt.iconv)) : rs;
							stream.pause();
				
							// assemble and write cache
							fs.writeFile(cachefile, JSON.stringify({
								last: Date.now(),
								modified: (rs.hasOwnProperty("lastModified") ? rs.lastModified : false),
							},null,"\t"), function(err){
								if (err) console.error("Unable to write cache file: %s – %s", cachefile, err);
								stream.resume();
								return fn(null, true, stream, { statusCode: 200, headers: { "last-modified": rs.lastModified } });
							});
				
						});
						
					break;
					case "file:":
						const file = url.parse(opt.url.replace(/^file:\/+/g,'file:/')).pathname

						fs.stat(file, function(err, stat){
							if (err) return fn(err, false, "error");
				
							// generate fake etag from stat
							const etag = [stat.size, stat.ino, stat.mtime.valueOf()].map(function(v){ return v.toString(36); }).join("-");
				
							// check etag against cache
							if (etag === req_opts.headers["If-None-Match"]) return fn(null, false, "cache-hit");

							let stream = fs.createReadStream(file);
							stream.pause();

							stream = (opt.iconv && iconv) ? stream.pipe(iconv.decodeStream(opt.iconv)) : stream;

							// assemble and write cache
							fs.writeFile(cachefile, JSON.stringify({
								last: Date.now(),
								etag: etag,
								size: stat.size,
							},null,"\t"), function(err){
								if (err) console.error("Unable to write cache file: %s – %s", cachefile, err);
								stream.resume();
								return fn(null, true, stream, { statusCode: 200, headers: { "content-length": stat.size, "last-modified": stat.mtime, "etag": etag } });
							});
				
						});
					break;
					default:
						fn(new Error("Unknown Protocol"), false, "error");
					break;
				};
				
			})();

			self.request(opt, req_opts, function(err, resp, data){
				if (err) return fn(err, false, "error");
				if (resp.statusCode === 304) return fn(null, false, "cache-hit");
				if (req_opts.headers["If-None-Match"] && resp.headers.etag && resp.headers.etag === req_opts.headers["If-None-Match"]) return fn(null, false, "cache-hit"); // client-side if-none-match, because some servers don't bother
				if (cache && opt.sizechange && resp.headers.hasOwnProperty("content-length") && cache.hasOwnProperty("size") && cache.size === parseInt(resp.headers["content-length"],10)) return this.destroy(), fn(null, false, "cache-hit"); // assume no change if same size because CDNs are weird
				if (opt.successCodes.indexOf(resp.statusCode) <0) return fn(new Error("Got Status Code "+resp.statusCode), false, "error");
				
				// decode
				if (opt.iconv && iconv) data = iconv.decode(data, opt.iconv);
				
				// preprocess
				(function(next){
					if (!opt.preprocess) return next(data);

					opt.preprocess(data, function(err, data){
						if (err) return fn(err, false, "error");
						return next(data);
					}, resp);

				})(function(data){

					// calculate hash of raw data
					const data_hash_raw = self.hash(data);
				
					// check if raw data changed
					if (opt.cache && cache && data_hash_raw === cache.hash) return fn(null, false, "no-change");
				
					(function(next){
					
						if (!opt.parse) return next(null, data);
						// parse if needed
						switch (opt.parse) {
							case "csv":
							case "tsv":
							case "ssv":
								if (xsv === null) return next(new Error("xsv not available"));
						
								var result = [];
								xsv({ ...self.xsv_opts[opt.parse], ...opt.xsv }).on("data", function(record){
									result.push(record);
								}).on("end", function(){
									return next(null, result);
								}).end(data);
						
							break;
							case "xlsx":
								if (xlsx === null) return next(new Error("xlsx not available"));
							
								// parse xlsx
								try {
									var table = xlsx.read(data, { type: 'buffer', cellText: false, cellDates: true });
								} catch (err) {
									return next(new Error("XLSX parse error: "+err));
								}
							
								// export sheets
								try {
									var result = table.SheetNames.reduce(function(records, sheetname){
										return records[sheetname] = xlsx.utils.sheet_to_json(table.Sheets[sheetname], { header: 1, dateNF: 'yyyy"-"mm"-"dd', defval: null, ...opt.xlsx }), records;
									},{});
								} catch (err) {
									return next(new Error("XLSX export error: "+err));
								}
							
								return next(null, result);
							
							break;
							case "yaml":
								if (yaml === null) return next(new Error("yaml not available"));
						
								try {
									data = yaml.parse(data);
								} catch (err) {
									return next(err);
								}

								return next(null, data);

							break;
							case "html":
								if (cheerio === null) return next(new Error("cheerio not available"));
						
								try {
									data = cheerio.load(data);
								} catch (err) {
									return next(err);
								}

								// mark as cheerio
								data.isCheerio = true;

								return next(null, data);

							break;
							case "dw":
								if (dw === null) return next(new Error("dataunwrapper not available"));
						
								// use dataunwrapper
								dw.extract(data, function(err, data){
									if (err) return next(err);

									// could be json, let's try
									try {
										data = JSON.parse(data);
										return next(null, data);
									} catch (err) {
										
										// probably csv
										var result = [];
										xsv({ ...self.xsv_opts["csv"] }).on("data", function(record){
											result.push(record);
										}).on("end", function(){
											return next(null, result);
										}).end(data);
										
									}

								});

							break;
							case "xml":
								if (xml === null) return next(new Error("xml2js not available"));
								return xml(data, next);
							break;
							case "pdf":
								if (pdf === null) return next(new Error("pdf.js-extract not available"));
								return (new pdf()).extractBuffer(data, opts.pdf, next);
							break;
							case "kdl":
								if (kdl === null) return next(new Error("kdljs not available"));

								try {
									data = kdl(data);
								} catch (err) {
									return next(err);
								}
								
								return next(((data.errors instanceof Array && data.errors.length && data.errors) || null), data.output);
							break;
							case "json":

								try {
									data = JSON.parse(data);
								} catch (err) {
									return next(err);
								}

								return next(null, data);
							break;
							default:
								return next(null, data);
							break;
						}
					
					})(function(err, data){
						if (err) return fn(err, false, "error");

						// convert xml and json formats to strings (needle only converts text/* mime types)
						if (data instanceof Buffer && resp.headers.hasOwnProperty("content-type") && (["json","xml"].indexOf(resp.headers["content-type"].split(";").shift().split(/\/|\+/).pop()) >= 0)) data = data.toString();

						// check for processing function
						(function(next){
							if (!opt.process) return next(data);
						
							opt.process(data, function(err, data){
								if (err) return fn(err, false, "error");
								return next(data);
							}, resp);
						
						})(function(data){

							// create hash of processed data
							const data_hash_processed = self.hash(data);

							// check if (processed) data changed
							if (opt.cache && cache && data_hash_processed === cache.hashp) return fn(null, false, "no-change");

							// assemble and write cache
							fs.writeFile(cachefile, JSON.stringify({
								last: Date.now(),
								hash: data_hash_raw,
								hashp: data_hash_processed,
								modified: (resp.headers.hasOwnProperty("last-modified") ? resp.headers["last-modified"] : false),
								etag: (resp.headers.hasOwnProperty("etag") ? resp.headers["etag"] : false),
								size: (resp.headers.hasOwnProperty("content-length") ? (parseInt(resp.headers["content-length"],10) || false) : false),
							},null,"\t"), function(err){
								if (err) console.error("Unable to write cache file: %s – %s", cachefile, err);
								return fn(null, true, data);
							});
						
						});
					});
				});
			});
		});
		
		return self;
		
	};
};

// request, but with following html meta redirects
scrpr.prototype.request = function(opt, req_opts, fn){
	const self = this;
	
	switch (url.parse(opt.url).protocol) {
		case "http:":
		case "https:":

			needle.request(opt.method, opt.url, opt.data, req_opts, function(err, resp, data){
				if (!opt.metaredirects || err || resp.statusCode !== 200 || resp.headers["content-type"] !== "text/html") return fn.apply(this, arguments);
		
				if (!/(<meta[^>]+http-equiv="refresh"[^>]*>)/i.test(data)) return fn.apply(this, arguments);;
				if (!/content="([0-9]+;\s*)?url=([^"]+)"/i.test(RegExp.$1)) return fn.apply(this, arguments);;

				const redirect = url.resolve(opt.url, RegExp.$2);
				const redirected = (opt.redirected||0)+1;

				if (redirect === opt.url || redirected > 5) return fn.apply(this, arguments); // prevent redir loop

				return self.request({ ...opt, redirected: redirected, url: redirect }, req_opts, fn);
			}).once("error", function(err){
				return fn(err), fn = function(){};
			});
		break;
		case "ftp:":
			if (geturi === null) return fn(new Error("get-uri not available"), { statusCode: 500 }, null);
						
			geturi(opt.url, { cache: { lastModified: req_opts.headers["If-Modified-Since"], } }, function(err, stream) {
				if (err && err.code === 'ENOTMODIFIED') return fn(null, { statusCode: 304 }, null);
				if (err) return fn(err, {}, null);
				
				// capture data
				const data = [];
				stream.on('data', function(chunk){
					data.push(Buffer.from(chunk));
				}).on('end', function(){

					// simulate bare minimum needle callback
					fn(null, { 
						statusCode: 200,
						headers: {
							"content-type": (mime.lookup(path.extname(url.parse(opt.url).pathname))||"application/octet-stream"),
							"last-modified": stream.lastModified,
						}
					}, Buffer.concat(data));
					
				});
				
			});
			
		break;
		case "file:":
			const file = url.parse(opt.url.replace(/^file:\/+/g,'file:/')).pathname

			fs.stat(file, function(err, stat){
				if (err) return fn(err, { statusCode: 500 }, null);
				
				// generate fake etag from stat
				const etag = [stat.size, stat.ino, stat.mtime.valueOf()].map(function(v){ return v.toString(36); }).join("-");
				
				// check etag against cache
				if (etag === req_opts.headers["If-None-Match"]) return fn(null, { statusCode: 304 }, null);
				
				fs.readFile(file, function(err, contents){
					if (err) return fn(err, { statusCode: 500 }, null);
					
					// simulate bare minimum needle callback
					fn(null, { 
						statusCode: 200,
						headers: {
							"last-modified": stat.mtime,
							"content-type": (mime.lookup(path.extname(file))||"application/octet-stream"),
							"content-length": stat.size,
							"etag": etag,
						}
					}, contents);

				});
				
			});
		break;
		default:
			return fn(new Error("Unknown Protocol"));
		break;
	}
	
};

// hash helper
scrpr.prototype.hash = function(v){
	return crypto.createHash("sha256").update(this.stringify(v)).digest("hex");
};

// extended object serializer
scrpr.prototype.stringify = function(v){
	return (v instanceof Buffer) ? v : JSON.stringify(v, function(k,v){
		if (v&&!!v.isCheerio) return v.html();
		if (typeof v === "function") return v.toString();
		if (v instanceof Date) return v.toISOString();
		if (v instanceof Buffer) return v.toString('hex');
		return v;
	});
}

module.exports = scrpr;
