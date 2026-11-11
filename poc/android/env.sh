# Toolchains for the Android probe, installed per user (no sudo). Use: source env.sh
export JAVA_HOME="$HOME/.jdks/jdk-17.0.21+9"
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/30.0.16248370"
export PATH="$HOME/.cargo/bin:$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
