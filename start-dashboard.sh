#!/bin/bash

# RagCode Dashboard 启动脚本

# 设置默认环境变量
export RAGCODE_GRAPH_STORE=${RAGCODE_GRAPH_STORE:-"sqlite"}
export RAGCODE_SQLITE_PATH=${RAGCODE_SQLITE_PATH:-".ragcode/graph.sqlite"}
export RAGCODE_SEMANTIC_STORE=${RAGCODE_SEMANTIC_STORE:-"lancedb"}
export RAGCODE_LANCEDB_URI=${RAGCODE_LANCEDB_URI:-".ragcode/lancedb"}
export RAGCODE_EMBEDDING_PROVIDER=${RAGCODE_EMBEDDING_PROVIDER:-"deterministic"}
export RAGCODE_WEB_PORT=${RAGCODE_WEB_PORT:-"3000"}

echo "======================================"
echo "  RagCode Dashboard Launcher"
echo "======================================"
echo ""
echo "Configuration:"
echo "  Graph Store: $RAGCODE_GRAPH_STORE"
echo "  Semantic Store: $RAGCODE_SEMANTIC_STORE"
echo "  Embedding Provider: $RAGCODE_EMBEDDING_PROVIDER"
echo "  Backend Port: $RAGCODE_WEB_PORT"
echo ""

# 启动后端
echo "Starting backend server..."
npm run web:server &
BACKEND_PID=$!

# 等待后端启动
sleep 3

# 启动前端
echo "Starting frontend dev server..."
cd web
npm run dev &
FRONTEND_PID=$!

cd ..

echo ""
echo "✓ Backend API running on http://localhost:$RAGCODE_WEB_PORT"
echo "✓ Frontend running on http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop both servers"

# 捕获 Ctrl+C
trap "echo 'Stopping servers...'; kill $BACKEND_PID $FRONTEND_PID; exit" INT

# 等待进程
wait
