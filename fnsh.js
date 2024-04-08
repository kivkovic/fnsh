#!/usr/bin/nodejs

const vm = require('vm');
const fs = require('fs');
const node_path = require('path');
const child_process = require('child_process');
const os = require('os');

function tryImport(path, fallback) {
  try {
    return require(path);
  } catch (e) {
    return fallback;
  }
}

const fileTypeFromFile = tryImport('./file-type', {}).fileTypeFromFile;
const commonApps = tryImport('./common-apps', {});

const sandbox = {
  echo, // echoes back the function argument
  path, // selects a file for further chaining
  sh, // executes an array of string tokens in native shell
  cat, // outputs file contents
  ls, // lists directory
  find, // ls + recurse + flatten with chained filter
  mv, // moves file
  cp, // copies file
  //head, // truncates a list to first n elements
  //tail, // truncates a list to last n elements
  //save, // write to file
  //mime, // get mime type for path
  exit, // exit with optional return code
  sys_info, // returns an object describing the host system
  ...commonApps,
  help,
}

function help() {
  return echo(
`Commands:

find(directory = '.', filter = (...args)=>boolean): Filepointer[]
ls(directory = '.', options?={recurse?:false, mime?:false}): Filepointer[]
path(filepath): Filepointer
mv(oldname, newname, overwrite=false): boolean
cp(oldname, newname, overwrite=false): boolean
save(path, content='', options? = {append?:false, force_rewrite?:false, encoding?:string}): void
sh(command, options={}): { stdout, stderr, status }
head(list, n): <any>[]
tail(list, n): <any>[]
echo(value): void
mime(filepath, options={ filecheck: true }): string
sys_info(): object
exit(exit_code=0): void

Filepointer properties/methods:
cat(), head(n), tail(n), toJSON(), mime, to_7z(outpath, options?={level,split,password}), from_7z(outpath, options?={password}), save(content, options)
`);
}

Object.prototype.save = function (path, options = {}) {
  return save(path, this.json(), options);
}

Object.prototype.json = function (options = {}) {
  return JSON.stringify(this, options?.replacer, options?.space);
}

Array.prototype.head = function (n = 1) {
  return head(this, n);
};

Array.prototype.tail = function (n = 1) {
  return tail(this, n);
};

Array.prototype.uniq = function (key = null) {
  if (key == null) {
    return this.filter((v, i, a) => a.indexOf(v) == i);
  }
  const keys = new Set();
  return this.filter((v, i, a) => {
    if (!keys.has(v[key])) {
      keys.add(v[key]);
      return true;
    }
    return false;
  });
}

String.prototype.head = function (n = 1, options = {}) {
  if (options?.bytes) {
    return head(Buffer.from(this)).toString();
  }
  return head(this.split(/\n/g), n).join('\n');
};

String.prototype.tail = function (n = 1, options = {}) {
  if (options?.bytes) {
    return tail(Buffer.from(this)).toString();
  }
  return tail(this.split(/\n/g), n).join('\n');
};

String.prototype.save = function (options = {}) {
  return save(path, this, options);
}

// nested context does not share parent's prototypes so we'll be running them manually later on
const prototypes = `
Object.prototype.save = ${Object.prototype.save.toString()};
Object.prototype.json = ${Object.prototype.json.toString()};
Array.prototype.head = ${Array.prototype.head.toString()};
Array.prototype.tail = ${Array.prototype.tail.toString()};
Array.prototype.uniq = ${Array.prototype.uniq.toString()};
String.prototype.head = ${String.prototype.head.toString()};
String.prototype.tail = ${String.prototype.tail.toString()};
String.prototype.save = ${String.prototype.save.toString()};
`;

class Filepointer {

  path = null;
  name = null;
  directory = null;
  type = null;
  mode = null;
  size = null;
  size_h = '';
  created = null;
  modified = null;
  #mimeType = null;

  constructor(fullpath) {
    const stats = fs.statSync(fullpath);
    this.path = fullpath; // new Filepath(fullpath);
    this.name = node_path.basename(fullpath); // this.path.name;
    this.directory = node_path.dirname(fullpath); // this.path.directory;

    if (stats.isFile()) this.type = 'file';
    else if (stats.isDirectory()) this.type = 'folder';
    else if (stats.isBlockDevice()) this.type = 'block_device';
    else if (stats.isCharacterDevice()) this.type = 'character_device';
    else if (stats.isSymbolicLink()) this.type = 'link';
    else if (stats.isSocket()) this.type = 'socket';
    else if (stats.isFIFO()) this.type = 'fifo';

    this.mode = (stats.mode & parseInt('777', 8)).toString(8);
    if (this.type == 'file') {
      this.setSize(stats.size);
    }
    this.created = stats.ctime;
    this.modified = stats.mtime;
  }

  setSize(size) {
    this.size = size;
    this.size_h = readableBytes(size);
  }

  #echoable() {
    if (this.type != 'file') return false;
    if (!fs.existsSync(this.path)) {
      throw `File doesn't exist: "${this}")`;
    }
    return true;
  }

  cat() {
    if (!this.#echoable) return null;

    return fs.readFileSync(this.path).toString();
  }

  head(n) {
    if (!this.#echoable) return null;

    let lines = '';
    const chunksize = 10000;
    const buffer = Buffer.alloc(chunksize);
    const fd = fs.openSync(this.path, 'r');
    let offset = 0;
    let linecount = 0;

    do {
      const len = fs.readSync(fd, buffer, 0, chunksize, offset);
      let currentlinecount = 0;
      for (let i = 0; i < len; i++) {
        if (buffer[i] == 0x0a) {
          currentlinecount++;
        }
        if (linecount + currentlinecount == n) {
          lines += buffer.toString('utf8', 0, i + 1);
          break;
        }
      }

      offset += chunksize;
      if (len < chunksize || linecount + currentlinecount >= n) break;

    } while (true);

    fs.closeSync(fd);

    return lines;
  }

  tail(n) {
    if (!this.#echoable) return null;

    let lines = '';
    const chunksize = 10000;
    const buffer = Buffer.alloc(chunksize);
    const fd = fs.openSync(this.path, 'r');
    let offset = fs.lstatSync(this.path).size - chunksize;
    let linecount = 0;

    do {
      const len = fs.readSync(fd, buffer, 0, chunksize, Math.max(0, offset));
      let currentlinecount = 0;
      for (let i = len - 1; i >= 0; i--) {
        if (buffer[i] == 0x0a) {
          currentlinecount++;
        }
        if (linecount + currentlinecount == n) {
          lines = buffer.toString('utf8', i + 1, len) + lines;
          break;
        }
      }

      offset -= chunksize;
      if (offset < 0 || linecount + currentlinecount >= n) break;

    } while (true);

    fs.closeSync(fd);

    return lines;
  }

  get mime() {
    if (this.#mimeType) return this.#mimeType;
    if (this.type == 'file') {
      this.#mimeType = mime(this.path.toString(), { filecheck: false });
    } else {
      this.#mimeType = this.type;
    }
    return this.#mimeType;
  }

  toJSON() {
    const copy = {};
    for (const key in this) {
      if (this.hasOwnProperty(key)) {
        copy[key] = this[key];
      }
    }
    if (this.#mimeType) {
      copy['mime'] = this.#mimeType;
    }
    return copy;
  }
}

for (const key in commonApps) {
  Filepointer.prototype[key] = function (...args) {
    return sh(commonApps[key].call(null, this.path, ...args));
  }
}

function runCode(content) {
  if ((content || '').trim().length < 1) return '';
  //if (content.charCodeAt(0) === 0xFEFF || content.charCodeAt(0) === 0xFFFE || content.charCodeAt(0) === 0xEFBBBF) {
  //  content = content.slice(1);
  //}
  const result = vm.runInNewContext(content, sandbox);
  return result;
};

function readableBytes(value) {
  if (value <= 1e4) return `${value} b`;
  if (value <= 1e7) return `${Math.round(value / 1024 * 100) / 100} kB`;
  if (value <= 1e10) return `${Math.round(value / 1024 / 1024 * 100) / 100} MB`;
  if (value <= 1e13) return `${Math.round(value / 1024 / 1024 / 1024 * 100) / 100} GB`;
  return `${Math.round(value / 1024 / 1024 / 1024 / 1024 * 100) / 100} TB`;
}

function isText(content) {
  if (content.length == 0) {
    return true;
  }

  const target = (content.charCodeAt(0) === 0xFEFF || content.charCodeAt(0) === 0xFFFE || content.charCodeAt(0) === 0xEFBBBF)
    ? content.slice(1)
    : content;

  return !!(target.match(/^[\u0020-\u{10ffff}\r\n]*$/u));
}

function find(directory = '.', filter = undefined) {
  const response = ls(directory, { recurse: true, flatten: true });
  return filter ? response.filter(filter) : response;
}

function ls(directory = '.', options = {}) {
  const results = [];

  fs.readdirSync(directory).forEach(filename => {
    const parentDirectory = node_path.resolve(directory);
    const fullpath = node_path.join(parentDirectory, filename);
    const response = new Filepointer(fullpath);

    if (options.mime) {
      response.mime; // trigger
    }

    if (options.recurse && response.type == 'folder') {
        const contents = ls(fullpath, options);
        response.setSize(contents.reduce((a, c) => a + c.size, 0));

        if (options.flatten) {
          contents.forEach(entry => results.push(entry));
        } else {
          response.contents = contents;
        }
    }

    results.push(response);
  });

  if (options.self) {
    const parentDirectory = node_path.resolve(directory);
    const response = new Filepointer(parentDirectory);
    if (options.recurse && response.type == 'folder') {
      response.setSize(results.reduce((a, c) => a + c.size, 0))
    }

    response.contents = results;

    return response;
  }

  return results;
}

function mv(oldname, newname, overwrite = false) {
  if (!overwrite && fs.existsSync(newname)) {
    throw `Destination already exists: mv("${oldname}", "${newname}")`;
  }

  fs.mkdirSync(node_path.dirname(newname), { recursive: true });

  try {
    fs.renameSync(oldname, newname);

	} catch (error) {
		if (error.code === 'EXDEV') {
			fs.copyFileSync(oldname, newname);
      fs.unlinkSync(oldname);

		} else {
			throw error;
		}
  }

  return true;
}

function cp(oldname, newname, overwrite = false) {
  if (!overwrite && fs.existsSync(newname)) {
    throw `Destination already exists: mv("${oldname}", "${newname}")`;
  }

  fs.mkdirSync(node_path.dirname(newname), { recursive: true });
  fs.copyFileSync(oldname, newname);

  return true;
}

function sh(command, options = {}) {
  const run = child_process.spawnSync(command[0], command.slice(1), { encoding : 'utf8', ...(options||{}) });
  return {
    stdout: run.stdout || '',
    stderr: run.stderr || '',
    status: run.status
  };
}

function head(list, n) {
  if (list instanceof Filepointer) {
    return list.head(n);
  }
  if (list instanceof Buffer) {
    return list.subarray(0, n);
  }
  return list.slice(0, n);
}

function tail(list, n) {
  if (list instanceof Filepointer) {
    return list.tail(n);
  }
  if (list instanceof Buffer) {
    return list.subarray(list.length - n, list.length);
  }
  return list.slice(list.length - n, list.length);
}

function cat(filepath) {
  return new Filepointer(filepath).cat();
}

function echo(value) {
  if (typeof value == 'string' || typeof value == 'number') {
    process.stdout.write(String(value));
  } else if (typeof value == 'object') {
    process.stdout.write(JSON.stringify(value, undefined, 2));
  } else if (typeof value == 'undefined') {
    process.stdout.write('null');
  } else {
    process.stdout.write(value.toString());
  }
  process.stdout.write('\n');
  //return value;
}

function path(filepath) {
  return new Filepointer(filepath);
}

function mime(filepath, options = { filecheck: true }) {
  if (options.filecheck) {
    const stats = fs.statSync(filepath);
    if (stats.isDirectory()) return 'folder';
    if (stats.isBlockDevice()) return 'block_device';
    if (stats.isCharacterDevice()) return 'character_device';
    if (stats.isSymbolicLink()) return 'link';
    if (stats.isSocket()) return 'socket';
    if (stats.isFIFO()) return 'fifo';
  }

  const fileType = typeof fileTypeFromFile == 'function' ? fileTypeFromFile(filepath) : null;
  if (fileType?.mime) return fileType.mime;

  const buffer = Buffer.alloc(1000);
  const fd = fs.openSync(filepath, 'r');
  const len = fs.readSync(fd, buffer, 0, 1000, 0);
  const head = buffer.toString('utf8', 0, len);
  fs.closeSync(fd);
  return isText(head) ? 'text/plain' : 'application/octet-stream';
}

function save(path, content = '', options = {}) {

  if (!path) throw `Path not specified for save()`;

  const append = options?.append ?? false;
  const encoding = options?.encoding ?? 'utf8'; // if content is a buffer, this is automatically ignored by fs
  const force_rewrite = options?.force_rewrite ?? true;

  if (!append && !force_rewrite && fs.existsSync(path)) {
    throw `Can't save to "${path}": 'append' and 'force_rewrite' are both set to false but file already exists`;
  }

  if (append) {
    fs.appendFileSync(path, content, { encoding });
  } else {
    fs.writeFileSync(path, content, { encoding });
  }
}

function sys_info() {

  const cpus = {};
  for (const cpu of os.cpus()) {
    const name = cpu.model.replace(/ +/g, ' ').trim();
    if (!cpus[name]) {
      cpus[name] = { model: name, speed: [] };
    }
    cpus[name].speed.push(cpu.speed);
  }

  const totalmem = os.totalmem();
  const freemem = os.freemem();
  const user = os.userInfo();

  const response = {
    cpus: Object.values(cpus),
    memory: {
      total: totalmem,
      free: freemem,
      total_h: readableBytes(totalmem),
      free_h: readableBytes(freemem),
    },
    os: {
      arch: os.arch(),
      platform: os.platform(),
      version: os.version(),
      release: os.release(),
      uptime: os.uptime(),
      loadavg: os.loadavg(),
      hostname: os.hostname(),
    },
    user: {
      ...user, // os.homedir() may differ from userInfo().homedir: https://nodejs.org/dist/latest/docs/api/os.html#osuserinfooptions
      tmpdir: os.tmpdir(),
    },
    network: os.networkInterfaces(),
  };
  if (typeof os.machine != 'undefined') { // since node 16.18.0
    response.os.machine = os.machine();
  }
  return response;
};

var readline_interface;

function exit(exit_code = 0) {
  if (readline_interface) {
    readline_interface.close();
  }
  process.exit(exit_code);
}


runCode(prototypes);


const options = process.argv.slice(2,-1);
const command = process.argv.length >= 3 ? process.argv.slice(-1)[0] : null;

const history_path = './fnsh.history';
const history_size = fs.existsSync(history_path) ? fs.lstatSync(history_path).size : 0;
if (history_size > 1000) {
  const t = path(history_path).tail(100);
  fs.writeFileSync(history_path, t);
}

try {

  if (command) { // script mode and command mode: reads passed string either as script path (-i) or command (no -i)
    fs.appendFileSync(history_path, command + '\n');

    try {
      const response = runCode(options.includes('-i') ? fs.readFileSync(command) : command);
      if (typeof response != 'undefined') echo(response);

    } catch (error) {
      console.log(`${error.name}: ${error.message}`);
    }

  } else { // interactive mode

    const readline = require('node:readline');
    readline_interface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    //process.stdin.setRawMode(true);

    let history_pointer = -1;
    let history_list = [];

    process.stdin.on('keypress', function (letter, key) {

      if (key.name == 'return' && key.meta) {
        process.stdout.write('\n  ');

      } else if (key.name == 'up' || key.name == 'down') {

        if (!history_list) {
          history_list = path(history_path).cat().split(/\n/g).filter(line => line.trim());
          history_pointer = history_list.length;
        }

        if (key.name == 'up') {
          history_pointer = Math.max(0, history_pointer - 1);
        }
        if (key.name == 'down') {
          history_pointer = Math.min(history_list.length - 1, history_pointer + 1);
        }

        readline_interface.write(null, { ctrl: true, name: 'u' }); // clears line
        readline_interface.write(history_list[history_pointer].replace(/\n$/,''));
      }
    });

    const waitforline = function () {
      readline_interface.question('> ', (line) => {
        fs.appendFileSync(history_path, line + '\n');
        history_pointer = history_list.length;

        try {
          const response = runCode(line);
          if (typeof response != 'undefined') echo(response);

        } catch (error) {
          console.log(`${error.name}: ${error.message}`);
        }

        waitforline();
      });
    }

    waitforline();
  }

} catch (e) { }
