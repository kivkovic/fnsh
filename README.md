Commands:

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
