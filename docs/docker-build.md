# Docker 打包命令

以下命令适用于 Bash / zsh，均在仓库根目录执行。Dockerfile 位于 `local/Dockerfile`，构建上下文必须是根目录的 `.`，因为构建需要同时读取 `local/` 和 `packages/`。

准备好已启动的 Docker 和 Buildx；构建过程中需要下载基础镜像与 npm 依赖，无需提前在宿主机执行 `npm install`。

## 本机打包

使用当前 Docker 构建器的默认架构，构建完成后将镜像加载到本地 Docker：

```bash
docker build -f local/Dockerfile . -t docker.hub.xgblack.cn/coolstudio/subboost:latest --push


docker buildx build \
  --file local/Dockerfile \
  --tag subboost:local \
  --load \
  .

docker image inspect subboost:local --format '{{.Os}}/{{.Architecture}}'
```

Apple Silicon 上的默认架构通常是 `linux/arm64`。部署到其他架构的服务器时，使用下面的指定架构命令。

## 为 Linux 服务器打包

x86_64 服务器使用 `linux/amd64`：

```bash
docker buildx build \
  --platform linux/amd64 \
  --file local/Dockerfile \
  --tag subboost:local-amd64 \
  --load \
  .
```

ARM64 服务器使用 `linux/arm64`：

```bash
docker buildx build \
  --platform linux/arm64 \
  --file local/Dockerfile \
  --tag subboost:local-arm64 \
  --load \
  .
```

跨架构构建要求构建器支持目标架构的运行环境或模拟器。可用 `docker buildx inspect --bootstrap` 查看 `Platforms`；模拟构建通常比原生构建慢。

## 可选：写入应用版本信息

Dockerfile 支持四个可选构建参数，与仓库发布流程一致：

| 参数 | 内容 |
| --- | --- |
| `APP_RELEASE_VERSION` | `package.json` 中的发布版本 |
| `APP_BUILD_SHA` | Git 完整提交号 |
| `APP_VERSION` | `发布版本+sha.12位提交号` |
| `APP_VERSION_TOKEN` | 与 `APP_VERSION` 相同的版本标识 |

下面的示例需要宿主机安装 Node.js 和 Git，自动读取版本信息并构建 AMD64 镜像：

```bash
SUBBOOST_RELEASE_VERSION=$(node -p 'require("./package.json").version')
SUBBOOST_BUILD_SHA=$(git rev-parse HEAD)
SUBBOOST_BUILD_VERSION="${SUBBOOST_RELEASE_VERSION}+sha.$(git rev-parse --short=12 HEAD)"

docker buildx build \
  --platform linux/amd64 \
  --file local/Dockerfile \
  --build-arg APP_RELEASE_VERSION="$SUBBOOST_RELEASE_VERSION" \
  --build-arg APP_BUILD_SHA="$SUBBOOST_BUILD_SHA" \
  --build-arg APP_VERSION="$SUBBOOST_BUILD_VERSION" \
  --build-arg APP_VERSION_TOKEN="$SUBBOOST_BUILD_VERSION" \
  --tag "subboost:${SUBBOOST_RELEASE_VERSION}-local-amd64" \
  --load \
  .
```

提交号取自 `HEAD`，镜像内容取自当前工作区，包含未提交的代码改动。镜像标签与应用版本信息分别设置；只改 `--tag` 不会设置这些应用版本参数。

## 多架构打包并推送

同时发布 `linux/amd64` 和 `linux/arm64`，使用 `docker-container` 构建器。首次执行时创建；如果已经存在 `subboost-builder`，跳过创建命令：

```bash
docker buildx create --name subboost-builder --driver docker-container
docker buildx inspect subboost-builder --bootstrap
```

确认 `Platforms` 包含所需架构。以下以 GHCR 为例，将 `your-namespace` 替换为自己有推送权限的仓库命名空间，镜像名称使用小写；也可以将整个镜像地址替换为其他镜像仓库地址，并相应修改登录地址。

```bash
SUBBOOST_IMAGE='ghcr.io/your-namespace/subboost:local'

docker login ghcr.io

docker buildx build \
  --builder subboost-builder \
  --platform linux/amd64,linux/arm64 \
  --file local/Dockerfile \
  --tag "$SUBBOOST_IMAGE" \
  --provenance=false \
  --push \
  .

docker buildx imagetools inspect "$SUBBOOST_IMAGE"
```

`--push` 将多架构镜像上传到镜像仓库；前面的单架构示例使用 `--load`，将镜像加载到本地。此多架构示例直接推送，不加载到本地 Docker。`--provenance=false` 与仓库现有发布流程保持一致。需要应用版本信息时，将上一节的四个 `--build-arg` 参数加入此构建命令。

## 导出镜像文件

先执行上面的 AMD64 单架构构建，再导出为 tar 文件，适合传到服务器后离线导入：

```bash
docker image save --output subboost-local-amd64.tar subboost:local-amd64
```

在目标服务器上执行：

```bash
docker image load --input subboost-local-amd64.tar
docker image inspect subboost:local-amd64 --format '{{.Os}}/{{.Architecture}}'
```

ARM64 镜像对应替换为 `subboost:local-arm64` 和 `subboost-local-arm64.tar`。`save` / `load` 只传输镜像，运行配置和 PostgreSQL 数据需要另外准备。镜像启动时会连接数据库执行迁移；所需环境变量可参考 [`local/local.env.example`](../local/local.env.example)，镜像部署配置可参考 [`local/docker-compose.image.yml`](../local/docker-compose.image.yml)。
