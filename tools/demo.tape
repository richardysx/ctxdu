# vhs 脚本：生成 README 用的演示 GIF
# 用法: vhs tools/demo.tape

Output demo.gif

Set Shell zsh
Set FontSize 14
Set Width 1240
Set Height 900
Set Padding 24
Set Theme "Github Dark"
Set TypingSpeed 55ms
Set Framerate 24

# 隐藏的准备工作：让提示符干净，并让 ctxdu 像已全局安装一样可用
Hide
Type "export PATH=/private/tmp/claude-501/-Users-chaoyang-Code/065b346b-d225-4976-b142-e3d2d640464b/scratchpad/bin:$PATH"
Enter
Type "export PS1='%F{green}$%f '"
Enter
Type "cd /Users/chaoyang/Code"
Enter
Type "clear"
Enter
Sleep 500ms
Show

Sleep 800ms
Type "ctxdu"
Sleep 400ms
Enter
Sleep 6s
