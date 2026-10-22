/**
 * 内置答案库（由 tools/scrape-levels.mjs 抓取 + 人工/离线生成）
 *
 * 用法：作为 userscript 的 @require 或在 quizbot.user.js 之前加载。
 * 脚本会按「关卡标题」优先匹配，命中即直接填入，不联网、不调模型。
 *
 * 重新生成：node tools/build-answers.mjs
 */
(function () {
  window.__QUIZBOT_ANSWERS__ = [
  {
    "index": 1,
    "title": "点亮训练室",
    "goal": "代码修复局的训练室刚刚重启。给机器人设置能量，然后让它走到蓝色终端。设置不少于 4 点能量，并让机器人前进 4 格到达终点。",
    "api": "me.moveForward()\n必须使用: for",
    "must": "for",
    "code": "me.setEnergy(4);\nfor (int i = 0; i < 4; i++) {\n    me.moveForward();\n}"
  },
  {
    "index": 2,
    "title": "变量命名检查",
    "goal": "训练室要求用有意义的变量名保存移动距离，让代码更容易读懂。使用 moveCount 变量保存移动次数，并让机器人到达终端。",
    "api": "me.setEnergy(int value)\nme.moveForward()\n必须使用: moveCount",
    "must": "moveCount",
    "code": "int moveCount = 4;\nme.setEnergy(moveCount);\nfor (int i = 0; i < moveCount; i++) {\n    me.moveForward();\n}"
  },
  {
    "index": 3,
    "title": "数据类型闸门",
    "goal": "控制台返回了状态值。请用 int、boolean 和 String 保存信息，再决定是否启动机器人。使用基本数据类型保存状态，条件满足时移动到终端。",
    "api": "boolean\nString\nstatus.equals(\"online\")\n必须使用: boolean",
    "must": "boolean",
    "code": "int energy = 4;\nboolean ready = true;\nString status = \"online\";\nif (status.equals(\"online\") && ready) {\n    me.setEnergy(energy);\n    for (int i = 0; i < energy; i++) {\n        me.moveForward();\n    }\n}"
  },
  {
    "index": 4,
    "title": "运算符能量表",
    "goal": "能源站给出基础能量和补偿能量。请用运算符计算最终移动距离。使用表达式算出 4 步能量，并移动到终端。",
    "api": "me.setEnergy(int value)\nme.moveForward()\n必须使用: +",
    "must": "+",
    "code": "int base = 2;\nint bonus = 3;\nint distance = base + bonus - 1;\nme.setEnergy(distance);\nfor (int i = 0; i < distance; i++) {\n    me.moveForward();\n}"
  },
  {
    "index": 5,
    "title": "避开仓库墙",
    "goal": "物流仓库的通道出现障碍。机器人需要在前方有墙时转向，否则继续前进。使用 frontIsWall() 判断墙壁，绕过障碍到达终点。",
    "api": "me.turnRight()\nme.turnLeft()\nme.moveForward()\n必须使用: if",
    "must": "if",
    "code": "for (int i = 0; i < 8; i++) {\n    if (me.frontIsWall()) {\n        me.turnRight();\n    } else {\n        me.moveForward();\n    }\n}"
  },
  {
    "index": 6,
    "title": "颜色 switch 分拣",
    "goal": "分拣中心把包裹颜色作为字符串返回。请用 switch 判断颜色并送到对应区域。读取红色包裹，使用 switch 分支，把它送到红色投递点。",
    "api": "switch (color)\ncase \"red\"\nbreak\n必须使用: switch",
    "must": "switch",
    "code": "String color = me.scanColor();\nswitch (color) {\n    case \"red\":\n        me.pick();\n        me.moveForward();\n        me.drop();\n        break;\n    default:\n        break;\n}"
  },
  {
    "index": 7,
    "title": "循环搬运",
    "goal": "循环工厂需要机器人把包裹搬到投递点。重复动作比一行一行硬写更可靠。拾取包裹，使用循环移动到投递点，并放下包裹。",
    "api": "me.drop()\nme.moveForward()\nme.turnLeft()\nme.turnRight()\n必须使用: for",
    "must": "for",
    "code": "me.pick();\nfor (int i = 0; i < 4; i++) {\n    me.moveForward();\n}\nme.drop();"
  },
  {
    "index": 8,
    "title": "直到终端前",
    "goal": "循环工厂的巡检通道很长，机器人需要一直前进，直到前方出现终端墙。使用 while 和 frontIsWall()，让机器人停在绿色终端格。",
    "api": "me.moveForward()\n必须使用: while",
    "must": "while",
    "code": "while (!me.frontIsWall()) {\n    me.moveForward();\n}"
  },
  {
    "index": 9,
    "title": "跳过第一次巡检",
    "goal": "巡检机器人第一轮只做系统自检，不移动；到达终端后如果前方是墙就停止循环。使用 continue 跳过第一次循环，使用 break 在终点前停止。",
    "api": "break\nme.frontIsWall()\nme.moveForward()\n必须使用: continue",
    "must": "continue",
    "code": "for (int i = 0; i < 8; i++) {\n    if (i == 0) {\n        continue;\n    }\n    if (me.frontIsWall()) {\n        break;\n    }\n    me.moveForward();\n}"
  },
  {
    "index": 10,
    "title": "日志巡检",
    "goal": "维修小队需要在关键步骤留下日志，方便教师讲解程序执行顺序。使用 me.log(...) 记录开始和结束，并移动到终端。",
    "api": "字符串拼接 +\nfor 循环\n必须使用: log",
    "must": "log",
    "code": "me.log(\"开始巡检\");\nfor (int i = 0; i < 4; i++) {\n    me.log(\"第 \" + (i + 1) + \" 步\");\n    me.moveForward();\n}\nme.log(\"巡检结束\");"
  },
  {
    "index": 11,
    "title": "颜色分拣",
    "goal": "物流仓库开始按颜色分拣。机器人需要读取包裹颜色，并把红色包裹送到红色投递点。使用 scanColor() 读取颜色，判断 red 后投递到红色区域。",
    "api": "color.equals(\"red\")\nme.pick()\nme.drop()\nme.moveForward()\n必须使用: String",
    "must": "String",
    "code": "String color = me.scanColor();\nif (color.equals(\"red\")) {\n    me.pick();\n    for (int i = 0; i < 3; i++) {\n        me.moveForward();\n    }\n    me.drop();\n}"
  },
  {
    "index": 12,
    "title": "数组路线",
    "goal": "地图终端给出一串路线参数。机器人需要按数组里的步数分段移动和转向。使用 int[] 保存路线，按 2、2 的步数走到终端。",
    "api": "for (int steps : route)\nme.frontIsWall()\nme.turnRight()\nme.moveForward()\n必须使用: int[]",
    "must": "int[]",
    "code": "int[] route = {2, 2};\nfor (int steps : route) {\n    for (int i = 0; i < steps; i++) {\n        me.moveForward();\n    }\n    me.turnRight();\n}"
  },
  {
    "index": 13,
    "title": "能量预算",
    "goal": "维修小队的电量有限。请用变量计算需要移动的次数，不要把每一步都写死。用变量保存移动次数，并让机器人刚好到达终端。",
    "api": "me.setEnergy(int value)\nme.moveForward()\n必须使用: int",
    "must": "int",
    "code": "int distance = 4;\nme.setEnergy(distance);\nfor (int i = 0; i < distance; i++) {\n    me.moveForward();\n}"
  },
  {
    "index": 14,
    "title": "错误保护",
    "goal": "仓库终端要求机器人移动前先检测前方，否则会撞墙。这个关卡适合课堂讲解运行失败原因。每次移动前先判断墙壁，安全到达终点。",
    "api": "me.turnRight()\nme.moveForward()\n必须使用: if",
    "must": "if",
    "code": "for (int i = 0; i < 8; i++) {\n    if (me.frontIsWall()) {\n        me.turnRight();\n    }\n    me.moveForward();\n}"
  },
  {
    "index": 15,
    "title": "方法返回值",
    "goal": "系统提供了一个 EnergyPlan 对象。请调用它的方法获取步数并执行计划。创建 EnergyPlan 对象，调用 steps() 和 apply(...) 完成移动。",
    "api": "plan.steps()\nplan.apply(me)\n必须使用: steps()",
    "must": "steps()",
    "code": "EnergyPlan plan = new EnergyPlan(4);\nint steps = plan.steps();\nplan.apply(me);"
  },
  {
    "index": 16,
    "title": "封装的能量计划",
    "goal": "EnergyPlan 内部用 private 保存步数，外部不能直接改字段，只能通过公开方法读取和执行。通过公开方法 steps() 和 apply(me) 使用封装对象。",
    "api": "public steps()\npublic apply(me)\n必须使用: EnergyPlan",
    "must": "EnergyPlan",
    "code": "EnergyPlan plan = new EnergyPlan(4);\nint steps = plan.steps();\nplan.apply(me);"
  },
  {
    "index": 17,
    "title": "抽象任务步骤",
    "goal": "MoveStep 继承抽象类 MissionStep，并实现 run(me) 方法。学生先使用这个对象理解抽象类的调用方式。用 MissionStep 类型接收 MoveStep 对象，并执行 run(me)。",
    "api": "class MoveStep extends MissionStep\nstep.run(me)\n必须使用: MissionStep",
    "must": "MissionStep",
    "code": "MissionStep step = new MoveStep(4);\nstep.run(me);"
  },
  {
    "index": 18,
    "title": "接口命令",
    "goal": "RobotCommand 是统一命令接口，ForwardCommand 是它的实现类。用接口类型保存实现类对象，并执行 run(me)。",
    "api": "class ForwardCommand implements RobotCommand\ncommand.run(me)\n必须使用: RobotCommand",
    "must": "RobotCommand",
    "code": "RobotCommand command = new ForwardCommand(4);\ncommand.run(me);"
  },
  {
    "index": 19,
    "title": "多态路线",
    "goal": "同一个 RobotCommand 数组里可以放不同命令对象，运行时会执行各自的 run(me)。使用接口数组保存前进和转向命令，组合出一条折线路线。",
    "api": "new ForwardCommand(2)\nnew TurnRightCommand()\n多态 run(me)\n必须使用: RobotCommand[]",
    "must": "RobotCommand[]",
    "code": "RobotCommand[] commands = {\n    new ForwardCommand(2),\n    new TurnRightCommand(),\n    new ForwardCommand(2)\n};\nfor (RobotCommand command : commands) {\n    command.run(me);\n}"
  },
  {
    "index": 20,
    "title": "集合任务队列",
    "goal": "调度中心把命令放入 List 队列，机器人按顺序执行每个命令。使用 ArrayList 保存 RobotCommand，并依次执行。",
    "api": "commands.add(...)\n增强 for 循环\n必须使用: ArrayList",
    "must": "ArrayList",
    "code": "ArrayList<RobotCommand> commands = new ArrayList<>();\ncommands.add(new ForwardCommand(2));\ncommands.add(new TurnRightCommand());\ncommands.add(new ForwardCommand(2));\nfor (RobotCommand command : commands) {\n    command.run(me);\n}"
  }
];
})();
