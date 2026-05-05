(pipe
  |> test()
  # Comments should be intended to be even with the other lines
  |> (test2
    |> test3()
    # another comment
    |> test4())
  # comment
  # comment
  |> test5())
  
