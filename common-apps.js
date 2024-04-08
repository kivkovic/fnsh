const PATH_7Z = 'C:/Program Files/7-Zip/7z.exe';



/* the following functions return lists of string tokens to be passed to the sh() function */

function to_7z(input, output, { level, split, password } = {}) {
  const tokens = [PATH_7Z, 'a', '-t7z'];
  if (password) {
    tokens.push('-p' + password);
    tokens.push('-mhe=on');
  }
  if (split) {
    tokens.push('-v' + split);
  }
  if (level) {
    tokens.push('-mx' + level);
  }
  tokens.push(output);
  tokens.push(input);
  return tokens;
}

function from_7z(input, output, { password } = {}) {
  const tokens = [PATH_7Z, 'x', input];
  if (password) tokens.push('-p' + password);
  if (output) tokens.push('-o' + output); // note no space
  return tokens;
}

exports.to_7z = to_7z;
exports.from_7z = from_7z;
