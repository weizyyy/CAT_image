# 提示词管线

- `main-llm-instruction.txt` 给酒馆主模型使用，定义占位符。
- `roster/system.txt` 给聊天分析模型使用，定义人物一致性、回传结构与画面规则。
- `atomic-vocab.txt`、`wardrobe-vocab.txt`、`wardrobe-expand.txt` 定义锚点与造型。
- `pipeline/*-overlay.txt` 定义所选图像模型的写法。每次只装入一个模型的 overlay。
- 当前聊天的档案、造型及占位符通过 user 消息传入独立的分析请求。
